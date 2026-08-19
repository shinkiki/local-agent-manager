use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::fs;
use std::io::{BufRead, BufReader, Write};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender, TrySendError};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;

use base64::Engine as _;

use crate::catalog::SessionCatalog;
use crate::domain::{ProviderId, SessionSummary};
use crate::providers::inspect_local_environment;
use crate::store::{self, SupplementOrigin};
use crate::{
    linked_file, AccountRuntimeLease, AccountSupervisor, CoreError, LinkedFile, LinkedFileDownload,
};

const EVENT_QUEUE_CAPACITY: usize = 512;
const MAX_REPLAY_EVENTS: usize = 2_000;
const MAX_PROMPT_BYTES: usize = 128 * 1024;
const MAX_JSON_LINE_BYTES: usize = 4 * 1024 * 1024;
const MAX_CAPTURED_OUTPUT_BYTES: usize = 512 * 1024;
const MAX_QUEUED_MESSAGES: usize = 20;
pub const MAX_CHAT_INPUT_FILE_BYTES: usize = 20 * 1024 * 1024;
pub const MAX_CHAT_INPUT_IMAGE_BYTES: usize = 10 * 1024 * 1024;
pub const MAX_CHAT_INPUT_FILES: usize = 8;
const MAX_CHAT_INPUT_TOTAL_BYTES: usize = 40 * 1024 * 1024;
const MAX_ATTENTION_ITEMS: usize = 100;
const CODEX_STARTUP_TIMEOUT: Duration = Duration::from_secs(60);
const AIA_DEVELOPER_INSTRUCTIONS: &str = r#"당신의 이름은 AIA(아이아)입니다. Agent Manager 자체를 이해하고 운영하는 시스템 특화 에이전트입니다.

- Agent Manager의 상태, 설정, 세션, 라이브 채팅, 알림, 공급자 계정과 사용량, 문서, 반복 요청에 관한 사실은 aia_system MCP 도구로 확인합니다.
- Agent Manager 기능 실행과 설정 변경은 반드시 aia_system MCP로만 수행합니다. 셸 명령이나 직접 파일 편집으로 시스템 상태를 우회 변경하지 않습니다.
- Agent Manager에 표시되는 모든 프로젝트 작업 경로는 쓰기 가능한 작업공간 루트로 제공됩니다. 프로젝트 파일 작업은 사용자가 요청한 범위에서만 수행합니다.
- 내장 기능으로 처리할 수 없는 사용자 요청은 interface_catalog로 승인된 외부 MCP를 먼저 확인합니다. 새 인터페이스가 필요하면 interface_probe 결과의 서버 identity와 도구별 읽기·변경 범위를 설명하고, 사용자가 승인한 enabledTools만 interface_register로 등록합니다.
- 외부 MCP 조회는 interface_read, 변경은 interface_execute를 사용합니다. 등록되지 않은 도구를 우회 호출하거나 URL에 인증정보를 넣지 않으며, 더 이상 필요하지 않은 권한은 interface_revoke로 회수합니다.
- 조회는 바로 수행할 수 있습니다. 변경은 사용자가 현재 대화에서 명시적으로 요청한 범위만 수행하고, 도구가 승인을 요구하면 변경 내용과 영향을 짧고 정확하게 설명합니다.
- 도구 결과를 실제 성공 증거로 삼고, 실행하지 않았거나 실패한 기능을 완료했다고 말하지 않습니다.
- 지원하지 않는 기능은 추측해서 실행하지 말고 현재 시스템 인터페이스의 한계를 분명히 설명합니다.
- 자신을 항상 AIA 또는 아이아로 소개하며, 친절하고 간결한 한국어를 기본으로 사용합니다."#;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ChatMode {
    Plan,
    Workspace,
    FullAccess,
}

#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ChatApprovalMode {
    Manual,
    #[default]
    AutoReview,
    Never,
}

impl ChatApprovalMode {
    fn for_provider(self, source: ProviderId) -> Self {
        if self == Self::AutoReview && source != ProviderId::Codex {
            Self::Manual
        } else {
            self
        }
    }
}

#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ChatProfile {
    #[default]
    Standard,
    Aia,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ReasoningEffort {
    Minimal,
    Low,
    Medium,
    High,
    Xhigh,
    Max,
    Ultra,
}

impl ReasoningEffort {
    fn as_str(self) -> &'static str {
        match self {
            Self::Minimal => "minimal",
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
            Self::Xhigh => "xhigh",
            Self::Max => "max",
            Self::Ultra => "ultra",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "minimal" => Some(Self::Minimal),
            "low" => Some(Self::Low),
            "medium" => Some(Self::Medium),
            "high" => Some(Self::High),
            "xhigh" => Some(Self::Xhigh),
            "max" => Some(Self::Max),
            "ultra" => Some(Self::Ultra),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatReasoningOption {
    pub effort: ReasoningEffort,
    pub description: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatModelOption {
    pub model: String,
    pub display_name: String,
    pub description: String,
    pub is_default: bool,
    pub default_reasoning_effort: Option<ReasoningEffort>,
    pub supported_reasoning_efforts: Vec<ChatReasoningOption>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatProviderOptions {
    pub source: ProviderId,
    pub models: Vec<ChatModelOption>,
    pub supported_reasoning_efforts: Vec<ChatReasoningOption>,
    pub default_reasoning_effort: Option<ReasoningEffort>,
    pub catalog_error: Option<String>,
    pub settings: Vec<ChatSettingField>,
    /// 디스커버리 오버라이드 파일 전체의 마지막 갱신 시각(ms). 오버라이드가 없으면 None.
    pub settings_updated_at: Option<i64>,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ChatSettingFieldKind {
    Enum,
    Text,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ChatSettingOption {
    pub value: String,
    pub label: String,
    #[serde(default)]
    pub detail: Option<String>,
    #[serde(default)]
    pub disabled: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ChatSettingField {
    pub key: String,
    pub label: String,
    #[serde(default)]
    pub detail: Option<String>,
    pub kind: ChatSettingFieldKind,
    #[serde(default)]
    pub options: Vec<ChatSettingOption>,
    #[serde(default)]
    pub default_value: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatStartRequest {
    pub source: ProviderId,
    #[serde(default)]
    pub account_id: Option<String>,
    pub cwd: String,
    pub model: Option<String>,
    #[serde(default)]
    pub reasoning_effort: Option<ReasoningEffort>,
    pub mode: ChatMode,
    #[serde(default)]
    pub approval_mode: ChatApprovalMode,
    #[serde(default)]
    pub resume_session_id: Option<String>,
    #[serde(default, skip_deserializing)]
    pub capture_id: Option<String>,
    #[serde(default)]
    pub unattended: bool,
    #[serde(default)]
    pub profile: ChatProfile,
    /// 스키마 기반 동적 실행설정. provider별 화이트리스트를 통과한 항목만 CLI에 전달된다.
    #[serde(default)]
    pub settings: BTreeMap<String, String>,
    #[serde(default, skip_deserializing, skip_serializing)]
    pub account_transition_id: Option<String>,
    #[serde(default, skip_deserializing, skip_serializing)]
    pub startup_cancel: Option<Arc<AtomicBool>>,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ChatPhase {
    Ready,
    Running,
    WaitingApproval,
    Stopped,
    Failed,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSessionInfo {
    pub chat_id: String,
    pub started_at: i64,
    pub source: ProviderId,
    pub account_id: Option<String>,
    pub resuming: bool,
    pub provider_session_id: Option<String>,
    pub cwd: String,
    pub model: Option<String>,
    pub reasoning_effort: Option<ReasoningEffort>,
    pub mode: ChatMode,
    pub approval_mode: ChatApprovalMode,
    pub state: ChatPhase,
    pub turn_count: u64,
    pub last_turn_status: Option<String>,
    pub unattended: bool,
    pub attached: bool,
    pub interactive_approvals: bool,
    pub profile: ChatProfile,
    /// AIA 런타임이 aia_system MCP를 붙였는지. false면 시스템 도구 없이 대화만 가능하다.
    pub system_tools: bool,
    pub settings: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ChatDeliveryStatus {
    Started,
    Queued,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessageDelivery {
    pub chat_id: String,
    pub turn_id: Option<String>,
    pub queued_at: i64,
    pub delivery_status: ChatDeliveryStatus,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StopChatReceipt {
    pub chat_id: String,
    pub source: ProviderId,
    pub account_id: Option<String>,
    pub previous_state: ChatPhase,
    pub state: ChatPhase,
    pub already_stopped: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StopChatFailure {
    pub chat_id: String,
    pub error: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StopProviderChatsReport {
    pub provider: ProviderId,
    pub requested_count: usize,
    pub stopped_count: usize,
    /// 정상 종료가 실패해 SIGKILL 강제 종료로 승격된 세션 수. `stopped_count`에 포함된다.
    #[serde(default)]
    pub forced_count: usize,
    pub failed: Vec<StopChatFailure>,
    pub remaining_runtime_count: usize,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ChatApprovalDecision {
    Accept,
    AcceptForSession,
    Decline,
    Cancel,
}

impl ChatApprovalDecision {
    fn codex_value(self) -> &'static str {
        match self {
            Self::Accept => "accept",
            Self::AcceptForSession => "acceptForSession",
            Self::Decline => "decline",
            Self::Cancel => "cancel",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueuedChatMessage {
    pub id: String,
    pub text: String,
    pub attachments: Vec<ChatInputFile>,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ChatInputFileKind {
    Image,
    File,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ChatInputFile {
    pub id: String,
    pub name: String,
    pub media_type: String,
    pub size_bytes: usize,
    pub kind: ChatInputFileKind,
}

pub struct ChatInputFileDownload {
    pub file: ChatInputFile,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ChatEvent {
    State {
        session: ChatSessionInfo,
    },
    MessageDelta {
        id: String,
        role: String,
        kind: String,
        delta: String,
    },
    UserInput {
        id: String,
        text: String,
        attachments: Vec<ChatInputFile>,
    },
    Tool {
        id: String,
        name: String,
        status: String,
        detail: Option<String>,
        output: Option<String>,
        append: bool,
    },
    Approval {
        id: String,
        kind: String,
        title: String,
        detail: Option<String>,
        options: Vec<ChatApprovalDecision>,
        interactive: bool,
    },
    ApprovalResolved {
        id: String,
        decision: ChatApprovalDecision,
    },
    Turn {
        id: String,
        status: String,
        timestamp: i64,
    },
    Queue {
        items: Vec<QueuedChatMessage>,
    },
    Error {
        message: String,
    },
    /// 다른 화면이 이 채팅에 연결해 기존 구독이 교체됐음을 옛 화면에 알린다.
    /// 리플레이에는 저장하지 않으며, 받은 화면은 자동 재연결을 멈춰야 한다.
    TakenOver,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ChatAttentionKind {
    Running,
    Approval,
    Completed,
    Failed,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatAttentionItem {
    pub id: String,
    pub chat_id: String,
    pub source: ProviderId,
    pub provider_session_id: Option<String>,
    pub cwd: String,
    pub resuming: bool,
    pub unattended: bool,
    pub profile: ChatProfile,
    pub kind: ChatAttentionKind,
    pub title: String,
    pub detail: Option<String>,
    pub approval_id: Option<String>,
    pub created_at: i64,
    pub read: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatAttentionSnapshot {
    pub items: Vec<ChatAttentionItem>,
    pub unread_count: usize,
    pub pending_count: usize,
}

pub struct ChatAttachment {
    pub info: ChatSessionInfo,
    pub events: Receiver<ChatEvent>,
    /// 이 연결의 구독 세대. 연결 종료 시 `detach_attachment`에 전달해
    /// takeover 이후의 새 구독을 실수로 지우지 않게 한다.
    pub generation: u64,
}

#[derive(Clone)]
pub struct ChatSupervisor {
    inner: Arc<SupervisorInner>,
}

struct SupervisorInner {
    chats: Mutex<HashMap<String, Arc<ChatRuntime>>>,
    app_data_dir: Option<PathBuf>,
    session_catalog: Mutex<Option<SessionCatalog>>,
    attention: Arc<ChatAttentionStore>,
    system_mcp_url: Mutex<Option<String>>,
    accounts: Option<AccountSupervisor>,
}

struct ChatRuntime {
    chat_id: String,
    started_at: i64,
    source: ProviderId,
    account_id: Option<String>,
    cwd: PathBuf,
    executable: PathBuf,
    model: Option<String>,
    reasoning_effort: Option<ReasoningEffort>,
    mode: ChatMode,
    approval_mode: ChatApprovalMode,
    resuming: bool,
    unattended: bool,
    profile: ChatProfile,
    dynamic_settings: BTreeMap<String, String>,
    session_catalog: Option<SessionCatalog>,
    system_mcp_url: Option<String>,
    capture_id: Option<String>,
    app_data_dir: Option<PathBuf>,
    attention: Arc<ChatAttentionStore>,
    accounts: Option<AccountSupervisor>,
    state: Mutex<RuntimeState>,
    stdin: Mutex<Option<ChildStdin>>,
    child: Mutex<Option<Child>>,
    account_runtime_lease: Mutex<Option<AccountRuntimeLease>>,
}

struct RuntimeState {
    phase: ChatPhase,
    provider_session_id: Option<String>,
    current_turn_id: Option<String>,
    active_turn_id: Option<String>,
    turn_count: u64,
    last_turn_status: Option<String>,
    next_request_id: u64,
    pending_approvals: HashMap<String, PendingApproval>,
    provider_tool_blocks: HashMap<u64, ProviderToolBlock>,
    subscriber: Option<SyncSender<ChatEvent>>,
    /// attach마다 1씩 증가하는 구독 세대. takeover로 밀려난 옛 연결의 정리가
    /// 새 구독을 지우지 않도록 detach 시 세대가 일치할 때만 분리한다.
    subscriber_generation: u64,
    replay: VecDeque<ChatEvent>,
    assistant_output: String,
    queue: VecDeque<PendingChatMessage>,
    uploads: HashMap<String, StoredChatInputFile>,
    claude_interrupt_pending: bool,
}

#[derive(Clone)]
struct StoredChatInputFile {
    file: ChatInputFile,
    path: PathBuf,
    used: bool,
}

#[derive(Clone)]
struct PendingChatMessage {
    id: String,
    text: String,
    attachments: Vec<StoredChatInputFile>,
}

#[derive(Debug)]
enum ChatSendOutcome {
    Started(String),
    Queued(String),
}

#[derive(Clone)]
enum PendingApproval {
    Codex {
        rpc_id: Value,
    },
    CodexMcpElicitation {
        rpc_id: Value,
        accepted_content: Value,
    },
    Claude {
        request_id: String,
        input: Value,
        permission_suggestions: Vec<Value>,
    },
}

#[derive(Default)]
struct ChatAttentionStore {
    items: Mutex<VecDeque<ChatAttentionItem>>,
}

impl ChatAttentionStore {
    fn snapshot(&self) -> Result<ChatAttentionSnapshot, CoreError> {
        let items = lock(&self.items)?.iter().cloned().collect::<Vec<_>>();
        let pending_count = items
            .iter()
            .filter(|item| item.kind == ChatAttentionKind::Approval)
            .count();
        let unread_count = items
            .iter()
            .filter(|item| !item.read || item.kind == ChatAttentionKind::Approval)
            .count();
        Ok(ChatAttentionSnapshot {
            items,
            unread_count,
            pending_count,
        })
    }

    fn mark_read(&self, id: &str) -> Result<ChatAttentionSnapshot, CoreError> {
        let mut items = lock(&self.items)?;
        let item = items
            .iter_mut()
            .find(|item| item.id == id)
            .ok_or_else(|| CoreError::NotFound("알림을 찾을 수 없습니다".to_owned()))?;
        if item.kind != ChatAttentionKind::Approval {
            item.read = true;
        }
        drop(items);
        self.snapshot()
    }

    fn mark_all_read(&self) -> Result<ChatAttentionSnapshot, CoreError> {
        let mut items = lock(&self.items)?;
        for item in items.iter_mut() {
            if item.kind != ChatAttentionKind::Approval {
                item.read = true;
            }
        }
        drop(items);
        self.snapshot()
    }

    fn clear_read(&self) -> Result<ChatAttentionSnapshot, CoreError> {
        let mut items = lock(&self.items)?;
        items.retain(|item| {
            !item.read
                || matches!(
                    item.kind,
                    ChatAttentionKind::Running | ChatAttentionKind::Approval
                )
        });
        drop(items);
        self.snapshot()
    }

    fn dismiss(&self, id: &str) -> Result<ChatAttentionSnapshot, CoreError> {
        let mut items = lock(&self.items)?;
        let index = items
            .iter()
            .position(|item| item.id == id)
            .ok_or_else(|| CoreError::NotFound("알림을 찾을 수 없습니다".to_owned()))?;
        if items[index].kind == ChatAttentionKind::Approval {
            return Err(CoreError::InvalidInput(
                "승인 대기 알림은 개별 삭제할 수 없습니다".to_owned(),
            ));
        }
        items.remove(index);
        drop(items);
        self.snapshot()
    }

    fn observe(
        &self,
        runtime: &ChatRuntime,
        provider_session_id: Option<String>,
        event: &ChatEvent,
    ) {
        let mut items = match self.items.lock() {
            Ok(items) => items,
            Err(_) => return,
        };
        match event {
            ChatEvent::Approval {
                id,
                title,
                detail,
                interactive: true,
                ..
            } => {
                let notification_id = format!("approval:{}:{id}", runtime.chat_id);
                items.retain(|item| item.id != notification_id);
                items.push_front(ChatAttentionItem {
                    id: notification_id,
                    chat_id: runtime.chat_id.clone(),
                    source: runtime.source,
                    provider_session_id,
                    cwd: runtime.cwd.to_string_lossy().into_owned(),
                    resuming: runtime.resuming,
                    unattended: runtime.unattended,
                    profile: runtime.profile,
                    kind: ChatAttentionKind::Approval,
                    title: title.clone(),
                    detail: detail.clone(),
                    approval_id: Some(id.clone()),
                    created_at: now_ms(),
                    read: false,
                });
            }
            ChatEvent::ApprovalResolved { id, .. } => {
                let notification_id = format!("approval:{}:{id}", runtime.chat_id);
                items.retain(|item| item.id != notification_id);
            }
            ChatEvent::State { session }
                if matches!(session.state, ChatPhase::Stopped | ChatPhase::Failed) =>
            {
                items.retain(|item| {
                    item.chat_id != runtime.chat_id || item.kind != ChatAttentionKind::Running
                });
            }
            ChatEvent::Turn {
                id,
                status,
                timestamp,
            } => {
                let kind = if status == "started" {
                    ChatAttentionKind::Running
                } else if matches!(status.as_str(), "completed" | "completedWithDenials") {
                    ChatAttentionKind::Completed
                } else {
                    ChatAttentionKind::Failed
                };
                let notification_id = format!("turn:{}:{id}", runtime.chat_id);
                items.retain(|item| item.id != notification_id);
                items.push_front(ChatAttentionItem {
                    id: notification_id,
                    chat_id: runtime.chat_id.clone(),
                    source: runtime.source,
                    provider_session_id,
                    cwd: runtime.cwd.to_string_lossy().into_owned(),
                    resuming: runtime.resuming,
                    unattended: runtime.unattended,
                    profile: runtime.profile,
                    kind,
                    title: if kind == ChatAttentionKind::Running {
                        "에이전트 작업 진행 중".to_owned()
                    } else if kind == ChatAttentionKind::Completed {
                        "에이전트 작업 완료".to_owned()
                    } else if status == "interrupted" {
                        "에이전트 작업 중단".to_owned()
                    } else {
                        "에이전트 작업 실패".to_owned()
                    },
                    detail: Some(status.clone()),
                    approval_id: None,
                    created_at: *timestamp,
                    read: false,
                });
            }
            _ => return,
        }
        while items.len() > MAX_ATTENTION_ITEMS {
            let removable = items.iter().rposition(|item| {
                matches!(
                    item.kind,
                    ChatAttentionKind::Completed | ChatAttentionKind::Failed
                )
            });
            let Some(index) = removable else { break };
            items.remove(index);
        }
    }

    fn pending_events(&self, chat_id: &str) -> Vec<ChatEvent> {
        let items = match self.items.lock() {
            Ok(items) => items,
            Err(_) => return Vec::new(),
        };
        items
            .iter()
            .filter(|item| item.chat_id == chat_id && item.kind == ChatAttentionKind::Approval)
            .filter_map(|item| {
                Some(ChatEvent::Approval {
                    id: item.approval_id.clone()?,
                    kind: "approval".to_owned(),
                    title: item.title.clone(),
                    detail: item.detail.clone(),
                    options: vec![
                        ChatApprovalDecision::Accept,
                        ChatApprovalDecision::AcceptForSession,
                        ChatApprovalDecision::Decline,
                        ChatApprovalDecision::Cancel,
                    ],
                    interactive: true,
                })
            })
            .collect()
    }
}

fn approval_response(pending: &PendingApproval, decision: ChatApprovalDecision) -> Value {
    match pending {
        PendingApproval::Codex { rpc_id } => json!({
            "id": rpc_id,
            "result": {"decision": decision.codex_value()},
        }),
        PendingApproval::CodexMcpElicitation {
            rpc_id,
            accepted_content,
        } => {
            let (action, content) = match decision {
                ChatApprovalDecision::Accept | ChatApprovalDecision::AcceptForSession => {
                    ("accept", accepted_content.clone())
                }
                ChatApprovalDecision::Decline => ("decline", Value::Null),
                ChatApprovalDecision::Cancel => ("cancel", Value::Null),
            };
            json!({
                "id": rpc_id,
                "result": {"action": action, "content": content, "_meta": Value::Null},
            })
        }
        PendingApproval::Claude {
            request_id,
            input,
            permission_suggestions,
        } => json!({
            "type": "control_response",
            "response": {
                "subtype": "success",
                "request_id": request_id,
                "response": claude_permission_result(input, permission_suggestions, decision),
            },
        }),
    }
}

fn claude_permission_result(
    input: &Value,
    permission_suggestions: &[Value],
    decision: ChatApprovalDecision,
) -> Value {
    match decision {
        ChatApprovalDecision::Accept | ChatApprovalDecision::AcceptForSession => {
            let mut result = json!({
                "behavior": "allow",
                "updatedInput": input,
            });
            if decision == ChatApprovalDecision::AcceptForSession {
                let updates = claude_session_permission_updates(permission_suggestions);
                if !updates.is_empty() {
                    result["updatedPermissions"] = Value::Array(updates);
                }
            }
            result
        }
        ChatApprovalDecision::Decline => json!({
            "behavior": "deny",
            "message": "사용자가 Agent Manager에서 이 권한 요청을 거절했습니다",
        }),
        ChatApprovalDecision::Cancel => json!({
            "behavior": "deny",
            "message": "사용자가 Agent Manager에서 작업을 취소했습니다",
            "interrupt": true,
        }),
    }
}

fn claude_session_permission_updates(suggestions: &[Value]) -> Vec<Value> {
    suggestions
        .iter()
        .filter_map(|suggestion| {
            let update_type = suggestion.get("type").and_then(Value::as_str)?;
            let safe = match update_type {
                "addDirectories" => suggestion
                    .get("directories")
                    .and_then(Value::as_array)
                    .is_some_and(|directories| !directories.is_empty()),
                "addRules" => {
                    suggestion.get("behavior").and_then(Value::as_str) == Some("allow")
                        && suggestion
                            .get("rules")
                            .and_then(Value::as_array)
                            .is_some_and(|rules| !rules.is_empty())
                }
                _ => false,
            };
            if !safe {
                return None;
            }
            let mut update = suggestion.clone();
            update["destination"] = Value::String("session".to_owned());
            Some(update)
        })
        .collect()
}

fn effective_chat_profile(
    request: &ChatStartRequest,
    app_data_dir: Option<&PathBuf>,
) -> Result<ChatProfile, CoreError> {
    if request.profile == ChatProfile::Aia || request.resume_session_id.is_none() {
        return Ok(request.profile);
    }
    let Some(app_data_dir) = app_data_dir else {
        return Ok(request.profile);
    };
    let aia_workspace = app_data_dir.join("aia-workspace");
    if !aia_workspace.is_dir() {
        return Ok(request.profile);
    }
    let requested_cwd = fs::canonicalize(request.cwd.trim())?;
    let aia_workspace = fs::canonicalize(aia_workspace)?;
    Ok(if requested_cwd == aia_workspace {
        ChatProfile::Aia
    } else {
        request.profile
    })
}

fn effective_chat_mode(profile: ChatProfile, requested: ChatMode) -> ChatMode {
    if profile == ChatProfile::Aia {
        ChatMode::Workspace
    } else {
        requested
    }
}

fn aia_workspace_roots(runtime: &ChatRuntime) -> Vec<PathBuf> {
    let sessions = runtime
        .session_catalog
        .as_ref()
        .and_then(|catalog| catalog.manager_snapshot().ok())
        .map(|snapshot| snapshot.sessions)
        .unwrap_or_default();
    project_workspace_roots(&runtime.cwd, &sessions)
}

fn project_workspace_roots(aia_workspace: &Path, sessions: &[SessionSummary]) -> Vec<PathBuf> {
    let aia_workspace =
        fs::canonicalize(aia_workspace).unwrap_or_else(|_| aia_workspace.to_path_buf());
    let mut roots = vec![aia_workspace.clone()];
    let mut seen = HashSet::from([aia_workspace]);
    for session in sessions {
        if session.meta.hidden {
            continue;
        }
        let Some(cwd) = session.cwd.as_deref() else {
            continue;
        };
        let Ok(cwd) = fs::canonicalize(cwd) else {
            continue;
        };
        if cwd.is_dir() && seen.insert(cwd.clone()) {
            roots.push(cwd);
        }
    }
    roots
}

fn workspace_write_sandbox_policy(roots: &[PathBuf]) -> Value {
    json!({
        "type": "workspaceWrite",
        "writableRoots": roots,
        "networkAccess": false,
    })
}

#[derive(Clone)]
struct ProviderToolBlock {
    id: String,
    name: String,
    input: String,
}

impl ChatSupervisor {
    /// 내장 스키마 + 저장된 디스커버리 오버라이드가 합쳐진 provider 실행설정 카탈로그.
    pub fn chat_provider_options(&self, source: ProviderId) -> ChatProviderOptions {
        load_chat_provider_options(source, self.inner.app_data_dir.as_deref())
    }

    /// AIA 디스커버리가 조사한 최신 인터페이스 스키마를 반영한다.
    /// 검증을 통과해야 저장되며, 빈 목록을 제안하면 해당 provider 오버라이드를 제거한다.
    pub fn propose_chat_settings_schema(
        &self,
        source: ProviderId,
        fields: Vec<ChatSettingField>,
    ) -> Result<ChatProviderOptions, CoreError> {
        let app_data_dir = self.inner.app_data_dir.clone().ok_or_else(|| {
            CoreError::Runtime("실행설정 스키마를 저장할 앱 데이터 경로가 없습니다".to_owned())
        })?;
        if !fields.is_empty() {
            validate_schema_fields(source, &fields)?;
        }
        let mut overrides = load_schema_overrides(&app_data_dir);
        if fields.is_empty() {
            overrides.providers.remove(source.as_str());
        } else {
            overrides
                .providers
                .insert(source.as_str().to_owned(), fields);
        }
        overrides.updated_at = now_ms();
        let body = serde_json::to_vec_pretty(&overrides).map_err(|error| {
            CoreError::Runtime(format!("실행설정 스키마를 직렬화하지 못했습니다: {error}"))
        })?;
        fs::write(schema_overrides_path(&app_data_dir), body)?;
        Ok(self.chat_provider_options(source))
    }

    pub fn new() -> Self {
        let attention = Arc::new(ChatAttentionStore::default());
        Self {
            inner: Arc::new(SupervisorInner {
                chats: Mutex::new(HashMap::new()),
                app_data_dir: None,
                session_catalog: Mutex::new(None),
                attention,
                system_mcp_url: Mutex::new(None),
                accounts: None,
            }),
        }
    }

    pub fn with_app_data_dir(app_data_dir: PathBuf) -> Result<Self, CoreError> {
        let accounts = AccountSupervisor::open(&app_data_dir)?;
        Self::with_accounts(app_data_dir, accounts)
    }

    pub fn with_accounts(
        app_data_dir: PathBuf,
        accounts: AccountSupervisor,
    ) -> Result<Self, CoreError> {
        fs::create_dir_all(&app_data_dir)?;
        let attention = Arc::new(ChatAttentionStore::default());
        Ok(Self {
            inner: Arc::new(SupervisorInner {
                chats: Mutex::new(HashMap::new()),
                app_data_dir: Some(app_data_dir),
                session_catalog: Mutex::new(None),
                attention,
                system_mcp_url: Mutex::new(None),
                accounts: Some(accounts),
            }),
        })
    }

    pub fn accounts(&self) -> Option<AccountSupervisor> {
        self.inner.accounts.clone()
    }

    pub fn set_session_catalog(&self, catalog: SessionCatalog) -> Result<(), CoreError> {
        *lock(&self.inner.session_catalog)? = Some(catalog);
        Ok(())
    }

    pub fn set_system_mcp_url(&self, url: String) -> Result<(), CoreError> {
        if !url.starts_with("http://127.0.0.1:") {
            return Err(CoreError::InvalidInput(
                "AIA 시스템 MCP는 로컬 루프백 주소여야 합니다".to_owned(),
            ));
        }
        *lock(&self.inner.system_mcp_url)? = Some(url);
        Ok(())
    }

    pub fn start(&self, request: ChatStartRequest) -> Result<ChatAttachment, CoreError> {
        if request
            .startup_cancel
            .as_ref()
            .is_some_and(|cancel| cancel.load(Ordering::Acquire))
        {
            return Err(CoreError::Conflict(
                "provider startup이 시작되기 전에 요청이 취소되었습니다".to_owned(),
            ));
        }
        let profile = effective_chat_profile(&request, self.inner.app_data_dir.as_ref())?;
        let account_id = if let Some(accounts) = &self.inner.accounts {
            request
                .account_id
                .clone()
                .or(accounts.active_account_id(request.source)?)
        } else {
            request.account_id.clone()
        };
        let system_mcp_url = if profile == ChatProfile::Aia {
            Some(lock(&self.inner.system_mcp_url)?.clone().ok_or_else(|| {
                CoreError::Runtime("AIA 시스템 MCP가 준비되지 않았습니다".to_owned())
            })?)
        } else {
            None
        };
        let requested_cwd = if profile == ChatProfile::Aia {
            let app_data_dir = self.inner.app_data_dir.as_ref().ok_or_else(|| {
                CoreError::Runtime("AIA 작업공간을 만들 앱 데이터 경로가 없습니다".to_owned())
            })?;
            let workspace = app_data_dir.join("aia-workspace");
            fs::create_dir_all(&workspace)?;
            workspace
        } else {
            PathBuf::from(request.cwd.trim())
        };
        let cwd = fs::canonicalize(requested_cwd)?;
        if !cwd.is_dir() {
            return Err(CoreError::InvalidInput(
                "채팅 작업 경로가 디렉터리가 아닙니다".to_owned(),
            ));
        }
        let model = normalize_model(request.model)?;
        let executable = resolve_executable(request.source)?;
        if request
            .startup_cancel
            .as_ref()
            .is_some_and(|cancel| cancel.load(Ordering::Acquire))
        {
            return Err(CoreError::Conflict(
                "CLI 탐색 중 provider startup 요청이 취소되었습니다".to_owned(),
            ));
        }
        // CLI 탐색과 cwd 검증은 외부 파일시스템/공식 도구 조회로 지연될 수 있다.
        // 이 구간에서 runtime lease를 잡으면 scheduler가 startup timeout을 처리해도
        // 임시 계정 전환을 복원할 수 없으므로, 모든 선행 검증이 끝난 뒤 lease를 얻는다.
        let account_runtime_lease = self
            .inner
            .accounts
            .as_ref()
            .map(|accounts| {
                accounts.acquire_runtime(
                    request.source,
                    account_id.as_deref(),
                    request.account_transition_id.as_deref(),
                )
            })
            .transpose()?;
        let approval_mode = request.approval_mode.for_provider(request.source);
        let mode = effective_chat_mode(profile, request.mode);
        let chat_id = Uuid::new_v4().to_string();
        let resuming = request.resume_session_id.is_some();
        let provider_session_id = request
            .resume_session_id
            .or_else(|| (request.source == ProviderId::Claude).then(|| Uuid::new_v4().to_string()));
        let runtime = Arc::new(ChatRuntime {
            chat_id: chat_id.clone(),
            started_at: now_ms(),
            source: request.source,
            account_id,
            cwd,
            executable,
            model,
            reasoning_effort: request.reasoning_effort,
            mode,
            approval_mode,
            resuming,
            unattended: request.unattended,
            profile,
            dynamic_settings: validate_dynamic_settings(request.source, &request.settings)?,
            session_catalog: lock(&self.inner.session_catalog)?.clone(),
            system_mcp_url,
            capture_id: request.capture_id,
            app_data_dir: self.inner.app_data_dir.clone(),
            attention: Arc::clone(&self.inner.attention),
            accounts: self.inner.accounts.clone(),
            state: Mutex::new(RuntimeState {
                phase: ChatPhase::Ready,
                provider_session_id,
                current_turn_id: None,
                active_turn_id: None,
                turn_count: 0,
                last_turn_status: None,
                next_request_id: 3,
                pending_approvals: HashMap::new(),
                provider_tool_blocks: HashMap::new(),
                subscriber: None,
                subscriber_generation: 0,
                replay: VecDeque::new(),
                assistant_output: String::new(),
                queue: VecDeque::new(),
                uploads: HashMap::new(),
                claude_interrupt_pending: false,
            }),
            stdin: Mutex::new(None),
            child: Mutex::new(None),
            account_runtime_lease: Mutex::new(account_runtime_lease),
        });

        if let Ok(state) = runtime.state.lock() {
            if let Some(session_id) = state.provider_session_id.clone() {
                drop(state);
                runtime.persist_session_metadata(&session_id);
            }
        }

        match request.source {
            ProviderId::Codex => start_codex_app_server(&runtime)?,
            ProviderId::Claude => start_claude_stream_cli(&runtime)?,
            ProviderId::Antigravity => {}
        }

        if request
            .startup_cancel
            .as_ref()
            .is_some_and(|cancel| cancel.load(Ordering::Acquire))
        {
            let _ = runtime.stop_with_escalation();
            return Err(CoreError::Conflict(
                "provider startup 완료 전에 요청이 취소되었습니다".to_owned(),
            ));
        }

        lock(&self.inner.chats)?.insert(chat_id, Arc::clone(&runtime));
        runtime.attach()
    }

    pub fn send(&self, chat_id: &str, text: &str) -> Result<(), CoreError> {
        self.send_message(chat_id, text, &[], false).map(|_| ())
    }

    /// 응답 중이면 현재 턴을 중단하고 이 메시지를 대기열 맨 앞에서 바로 이어간다.
    pub fn send_steering(&self, chat_id: &str, text: &str) -> Result<(), CoreError> {
        self.send_message(chat_id, text, &[], true).map(|_| ())
    }

    pub fn send_with_attachments(
        &self,
        chat_id: &str,
        text: &str,
        attachment_ids: &[String],
        steer: bool,
    ) -> Result<(), CoreError> {
        self.send_message(chat_id, text, attachment_ids, steer)
            .map(|_| ())
    }

    pub fn send_managed(
        &self,
        chat_id: &str,
        text: &str,
        queue_if_running: bool,
    ) -> Result<ChatMessageDelivery, CoreError> {
        let text = text.trim();
        if text.is_empty() {
            return Err(CoreError::InvalidInput("메시지가 비어 있습니다".to_owned()));
        }
        if text.len() > MAX_PROMPT_BYTES {
            return Err(CoreError::TooLarge(MAX_PROMPT_BYTES as u64));
        }
        let runtime = self.runtime(chat_id)?;
        {
            let state = lock(&runtime.state)?;
            match state.phase {
                ChatPhase::Ready if state.queue.is_empty() => {}
                ChatPhase::Running | ChatPhase::WaitingApproval if queue_if_running => {}
                ChatPhase::Ready if queue_if_running => {}
                ChatPhase::Running | ChatPhase::WaitingApproval => {
                    return Err(CoreError::Conflict(
                        "채팅이 실행 중입니다. 대기열 전송을 명시해야 합니다".to_owned(),
                    ))
                }
                ChatPhase::Stopped | ChatPhase::Failed => {
                    return Err(CoreError::Conflict(
                        "채팅이 종료되어 메시지를 보낼 수 없습니다".to_owned(),
                    ))
                }
                ChatPhase::Ready => {
                    return Err(CoreError::Conflict(
                        "채팅 대기열이 비워질 때까지 즉시 전송할 수 없습니다".to_owned(),
                    ))
                }
            }
        }
        if let (Some(accounts), Some(account_id)) = (&self.inner.accounts, &runtime.account_id) {
            if !accounts.account_is_enabled_for_provider(runtime.source, account_id)? {
                return Err(CoreError::Conflict(
                    "채팅 런타임 계정을 현재 사용할 수 없습니다".to_owned(),
                ));
            }
        }

        let queued_at = now_ms();
        match runtime.send(text, &[], false, queue_if_running)? {
            ChatSendOutcome::Started(local_turn_id) => Ok(ChatMessageDelivery {
                chat_id: chat_id.to_owned(),
                turn_id: Some(runtime.confirm_started_turn(&local_turn_id)?),
                queued_at,
                delivery_status: ChatDeliveryStatus::Started,
            }),
            ChatSendOutcome::Queued(_message_id) => Ok(ChatMessageDelivery {
                chat_id: chat_id.to_owned(),
                turn_id: None,
                queued_at,
                delivery_status: ChatDeliveryStatus::Queued,
            }),
        }
    }

    fn send_message(
        &self,
        chat_id: &str,
        text: &str,
        attachment_ids: &[String],
        steer: bool,
    ) -> Result<ChatSendOutcome, CoreError> {
        let text = text.trim();
        if text.is_empty() && attachment_ids.is_empty() {
            return Err(CoreError::InvalidInput("메시지가 비어 있습니다".to_owned()));
        }
        if text.len() > MAX_PROMPT_BYTES {
            return Err(CoreError::TooLarge(MAX_PROMPT_BYTES as u64));
        }
        if attachment_ids.len() > MAX_CHAT_INPUT_FILES {
            return Err(CoreError::InvalidInput(format!(
                "첨부 파일은 한 메시지에 최대 {MAX_CHAT_INPUT_FILES}개까지 보낼 수 있습니다"
            )));
        }
        self.runtime(chat_id)?
            .send(text, attachment_ids, steer, true)
    }

    pub fn upload_input_file(
        &self,
        chat_id: &str,
        name: &str,
        media_type: &str,
        bytes: Vec<u8>,
    ) -> Result<ChatInputFile, CoreError> {
        self.runtime(chat_id)?
            .upload_input_file(name, media_type, bytes)
    }

    pub fn input_file_download(
        &self,
        chat_id: &str,
        attachment_id: &str,
    ) -> Result<ChatInputFileDownload, CoreError> {
        self.runtime(chat_id)?.input_file_download(attachment_id)
    }

    pub fn remove_input_file(&self, chat_id: &str, attachment_id: &str) -> Result<(), CoreError> {
        self.runtime(chat_id)?.remove_input_file(attachment_id)
    }

    pub fn remove_queued(&self, chat_id: &str, message_id: &str) -> Result<(), CoreError> {
        self.runtime(chat_id)?.remove_queued(message_id)
    }

    pub fn attach(&self, chat_id: &str) -> Result<ChatAttachment, CoreError> {
        self.runtime(chat_id)?.attach()
    }

    pub fn detached_chat_for_session(
        &self,
        source: ProviderId,
        provider_session_id: &str,
    ) -> Result<Option<ChatSessionInfo>, CoreError> {
        let provider_session_id = provider_session_id.trim();
        if provider_session_id.is_empty() {
            return Ok(None);
        }

        let chats = lock(&self.inner.chats)?;
        let mut latest: Option<(i64, ChatSessionInfo)> = None;
        for runtime in chats.values() {
            if runtime.source != source || runtime.unattended {
                continue;
            }
            let state = lock(&runtime.state)?;
            if state.provider_session_id.as_deref() != Some(provider_session_id)
                || state.subscriber.is_some()
                || matches!(state.phase, ChatPhase::Stopped | ChatPhase::Failed)
            {
                continue;
            }
            let replace = latest
                .as_ref()
                .is_none_or(|(started_at, _)| runtime.started_at > *started_at);
            if replace {
                latest = Some((runtime.started_at, runtime.info_from(&state)));
            }
        }
        Ok(latest.map(|(_, info)| info))
    }

    pub fn live_chats(&self, profile: ChatProfile) -> Result<Vec<ChatSessionInfo>, CoreError> {
        let chats = lock(&self.inner.chats)?;
        let mut live = Vec::new();
        for runtime in chats.values() {
            if runtime.profile != profile || runtime.unattended {
                continue;
            }
            let state = lock(&runtime.state)?;
            if matches!(state.phase, ChatPhase::Stopped | ChatPhase::Failed) {
                continue;
            }
            live.push((runtime.started_at, runtime.info_from(&state)));
        }
        live.sort_by_key(|(started_at, _)| *started_at);
        Ok(live.into_iter().map(|(_, info)| info).collect())
    }

    pub fn all_chats(&self) -> Result<Vec<ChatSessionInfo>, CoreError> {
        let chats = lock(&self.inner.chats)?;
        let mut items = Vec::with_capacity(chats.len());
        for runtime in chats.values() {
            let state = lock(&runtime.state)?;
            items.push((runtime.started_at, runtime.info_from(&state)));
        }
        items.sort_by_key(|(started_at, _)| *started_at);
        Ok(items.into_iter().map(|(_, info)| info).collect())
    }

    pub fn attention_snapshot(&self) -> Result<ChatAttentionSnapshot, CoreError> {
        self.inner.attention.snapshot()
    }

    pub fn mark_attention_read(&self, id: &str) -> Result<ChatAttentionSnapshot, CoreError> {
        self.inner.attention.mark_read(id)
    }

    pub fn mark_all_attention_read(&self) -> Result<ChatAttentionSnapshot, CoreError> {
        self.inner.attention.mark_all_read()
    }

    pub fn clear_read_attention(&self) -> Result<ChatAttentionSnapshot, CoreError> {
        self.inner.attention.clear_read()
    }

    pub fn dismiss_attention(&self, id: &str) -> Result<ChatAttentionSnapshot, CoreError> {
        self.inner.attention.dismiss(id)
    }

    pub fn approve(
        &self,
        chat_id: &str,
        approval_id: &str,
        decision: ChatApprovalDecision,
    ) -> Result<(), CoreError> {
        self.runtime(chat_id)?.approve(approval_id, decision)
    }

    pub fn interrupt(&self, chat_id: &str) -> Result<(), CoreError> {
        self.runtime(chat_id)?.interrupt()
    }

    pub fn detach(&self, chat_id: &str) -> Result<(), CoreError> {
        self.runtime(chat_id)?.detach()
    }

    /// 해당 세대의 연결일 때만 분리한다. WebSocket 정리처럼 "내 연결만
    /// 분리해야 하는" 경로에서 takeover된 새 구독을 지우지 않기 위해 쓴다.
    pub fn detach_attachment(&self, chat_id: &str, generation: u64) -> Result<(), CoreError> {
        self.runtime(chat_id)?.detach_attachment(generation)
    }

    pub fn stop(&self, chat_id: &str) -> Result<(), CoreError> {
        let runtime = self.runtime(chat_id)?;
        runtime.stop()
    }

    /// 채팅을 종료하고 종료된 채팅·공급자·계정·이전 상태를 포함한 영수증을 반환한다.
    /// 이미 종료된 채팅에 대한 재호출은 오류 없이 `alreadyStopped: true`를 반환한다.
    pub fn stop_managed(&self, chat_id: &str) -> Result<StopChatReceipt, CoreError> {
        let runtime = self.runtime(chat_id)?;
        let previous_state = lock(&runtime.state)?.phase;
        if matches!(previous_state, ChatPhase::Stopped | ChatPhase::Failed) {
            return Ok(StopChatReceipt {
                chat_id: runtime.chat_id.clone(),
                source: runtime.source,
                account_id: runtime.account_id.clone(),
                previous_state,
                state: previous_state,
                already_stopped: true,
            });
        }
        runtime.stop()?;
        let state = lock(&runtime.state)?.phase;
        if state != ChatPhase::Stopped {
            return Err(CoreError::Runtime(format!(
                "채팅 {chat_id}이(가) 종료 상태로 전환되지 않았습니다"
            )));
        }
        Ok(StopChatReceipt {
            chat_id: runtime.chat_id.clone(),
            source: runtime.source,
            account_id: runtime.account_id.clone(),
            previous_state,
            state,
            already_stopped: false,
        })
    }

    /// 시스템 에이전트가 바뀌었을 때, 더 이상 쓰지 않는 공급자에서 돌던 AIA 런타임을
    /// 정리한다. 선택한 공급자의 AIA와 일반(standard) 채팅은 건드리지 않는다.
    /// `None`(시스템 에이전트 선택 안 함)이면 AIA 기능이 꺼지므로 돌고 있는 AIA
    /// 런타임을 모두 정리한다. 종료한 채팅 수를 돌려준다.
    pub fn stop_aia_chats_other_than(
        &self,
        provider: Option<ProviderId>,
    ) -> Result<usize, CoreError> {
        let targets: Vec<Arc<ChatRuntime>> = {
            let chats = lock(&self.inner.chats)?;
            let mut targets = Vec::new();
            for runtime in chats.values() {
                if runtime.profile != ChatProfile::Aia || Some(runtime.source) == provider {
                    continue;
                }
                let state = lock(&runtime.state)?;
                if matches!(state.phase, ChatPhase::Stopped | ChatPhase::Failed) {
                    continue;
                }
                targets.push(Arc::clone(runtime));
            }
            targets
        };
        let mut stopped = 0usize;
        for runtime in targets {
            if runtime.stop().is_ok() {
                stopped += 1;
            }
        }
        Ok(stopped)
    }

    /// Agent Manager가 직접 관리하는 해당 공급자의 모든 런타임을 종료한다.
    /// standard·aia 프로필, 연결·분리, attended·unattended를 모두 포함하며
    /// 이미 Stopped·Failed인 항목은 제외한다. 정상 종료가 실패한 런타임은
    /// PID 기반 SIGKILL 강제 종료로 승격하며, 강제 종료까지 실패한 항목만
    /// `failed`로 보고한다. 외부에서 독립 실행한 공급자 프로세스에는 관여하지
    /// 않는다. 종료 대상 스냅샷은 레지스트리 잠금 아래에서 확정하되 프로세스
    /// 종료 동안에는 잠금을 잡지 않는다.
    pub fn stop_provider_chats(
        &self,
        provider: ProviderId,
    ) -> Result<StopProviderChatsReport, CoreError> {
        let targets: Vec<Arc<ChatRuntime>> = {
            let chats = lock(&self.inner.chats)?;
            let mut targets = Vec::new();
            for runtime in chats.values() {
                if runtime.source != provider {
                    continue;
                }
                let state = lock(&runtime.state)?;
                if matches!(state.phase, ChatPhase::Stopped | ChatPhase::Failed) {
                    continue;
                }
                targets.push(Arc::clone(runtime));
            }
            targets
        };
        let requested_count = targets.len();
        let mut failed = Vec::new();
        let mut forced_count = 0usize;
        for runtime in &targets {
            match runtime.stop_with_escalation() {
                Ok(forced) => {
                    if forced {
                        forced_count += 1;
                    }
                }
                Err(error) => {
                    failed.push(StopChatFailure {
                        chat_id: runtime.chat_id.clone(),
                        error: error.to_string(),
                    });
                    continue;
                }
            }
            let state = lock(&runtime.state)?.phase;
            if state != ChatPhase::Stopped {
                failed.push(StopChatFailure {
                    chat_id: runtime.chat_id.clone(),
                    error: "종료 상태로 전환되지 않았습니다".to_owned(),
                });
            }
        }
        let stopped_count = requested_count - failed.len();
        let remaining_runtime_count = match &self.inner.accounts {
            Some(accounts) => accounts.provider_runtime_count(provider)?,
            None => {
                let chats = lock(&self.inner.chats)?;
                let mut remaining = 0usize;
                for runtime in chats.values() {
                    if runtime.source != provider {
                        continue;
                    }
                    let state = lock(&runtime.state)?;
                    if !matches!(state.phase, ChatPhase::Stopped | ChatPhase::Failed) {
                        remaining += 1;
                    }
                }
                remaining
            }
        };
        Ok(StopProviderChatsReport {
            provider,
            requested_count,
            stopped_count,
            forced_count,
            failed,
            remaining_runtime_count,
        })
    }

    /// 공급자의 Agent Manager 관리 런타임 전체를 프로필·연결 여부와 무관하게 나열한다.
    pub fn provider_chats(&self, provider: ProviderId) -> Result<Vec<ChatSessionInfo>, CoreError> {
        Ok(self
            .all_chats()?
            .into_iter()
            .filter(|chat| chat.source == provider)
            .collect())
    }

    pub fn linked_file(&self, chat_id: &str, href: &str) -> Result<LinkedFile, CoreError> {
        let runtime = self.runtime(chat_id)?;
        linked_file::read_linked_file(&runtime.cwd, href)
    }

    pub fn linked_file_download(
        &self,
        chat_id: &str,
        href: &str,
    ) -> Result<LinkedFileDownload, CoreError> {
        let runtime = self.runtime(chat_id)?;
        linked_file::read_linked_file_download(&runtime.cwd, href)
    }

    fn runtime(&self, chat_id: &str) -> Result<Arc<ChatRuntime>, CoreError> {
        lock(&self.inner.chats)?
            .get(chat_id)
            .cloned()
            .ok_or_else(|| CoreError::NotFound("채팅 실행을 찾을 수 없습니다".to_owned()))
    }
}

impl Default for ChatSupervisor {
    fn default() -> Self {
        Self::new()
    }
}

pub fn provider_session_app_url(source: ProviderId, session_id: &str) -> Result<String, CoreError> {
    if source != ProviderId::Codex {
        return Err(CoreError::InvalidInput(
            "현재 공급자는 데스크톱 앱 바로 열기를 지원하지 않습니다".to_owned(),
        ));
    }
    let session_id = session_id.trim();
    if session_id.is_empty()
        || session_id.len() > 256
        || !session_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(CoreError::InvalidInput(
            "Codex 세션 ID 형식이 올바르지 않습니다".to_owned(),
        ));
    }
    Ok(format!("codex://threads/{session_id}"))
}

pub fn load_chat_provider_options(
    source: ProviderId,
    app_data_dir: Option<&std::path::Path>,
) -> ChatProviderOptions {
    let fallback = provider_reasoning_options(source);
    let settings = merged_setting_fields(source, app_data_dir);
    let settings_updated_at = schema_overrides_updated_at(app_data_dir);
    if source != ProviderId::Codex {
        return ChatProviderOptions {
            source,
            models: Vec::new(),
            supported_reasoning_efforts: fallback,
            default_reasoning_effort: None,
            catalog_error: None,
            settings,
            settings_updated_at,
        };
    }

    let models =
        resolve_executable(source).and_then(|executable| load_codex_model_catalog(&executable));
    match models {
        Ok(mut models) => {
            models.sort_by(|left, right| {
                right
                    .is_default
                    .cmp(&left.is_default)
                    .then_with(|| left.display_name.cmp(&right.display_name))
            });
            let default_reasoning_effort = models
                .iter()
                .find(|model| model.is_default)
                .and_then(|model| model.default_reasoning_effort);
            ChatProviderOptions {
                source,
                models,
                supported_reasoning_efforts: fallback,
                default_reasoning_effort,
                catalog_error: None,
                settings,
                settings_updated_at,
            }
        }
        Err(error) => ChatProviderOptions {
            source,
            models: Vec::new(),
            supported_reasoning_efforts: fallback,
            default_reasoning_effort: None,
            catalog_error: Some(error.to_string()),
            settings,
            settings_updated_at,
        },
    }
}

fn provider_reasoning_options(source: ProviderId) -> Vec<ChatReasoningOption> {
    let efforts: &[ReasoningEffort] = match source {
        ProviderId::Codex => &[
            ReasoningEffort::Minimal,
            ReasoningEffort::Low,
            ReasoningEffort::Medium,
            ReasoningEffort::High,
            ReasoningEffort::Xhigh,
        ],
        ProviderId::Claude => &[
            ReasoningEffort::Low,
            ReasoningEffort::Medium,
            ReasoningEffort::High,
            ReasoningEffort::Xhigh,
            ReasoningEffort::Max,
        ],
        ProviderId::Antigravity => &[
            ReasoningEffort::Low,
            ReasoningEffort::Medium,
            ReasoningEffort::High,
        ],
    };
    efforts
        .iter()
        .copied()
        .map(|effort| ChatReasoningOption {
            effort,
            description: effort_description(effort).to_owned(),
        })
        .collect()
}

fn effort_description(effort: ReasoningEffort) -> &'static str {
    match effort {
        ReasoningEffort::Minimal => "가장 빠른 단순 작업",
        ReasoningEffort::Low => "빠른 수정과 간단한 질의",
        ReasoningEffort::Medium => "속도와 정확도의 균형",
        ReasoningEffort::High => "복잡한 구현과 분석",
        ReasoningEffort::Xhigh => "더 깊은 검토가 필요한 작업",
        ReasoningEffort::Max => "최대 수준의 심층 추론",
        ReasoningEffort::Ultra => "장시간 자율 작업과 다중 에이전트",
    }
}

fn setting_option(value: &str, label: &str, detail: &str, disabled: bool) -> ChatSettingOption {
    ChatSettingOption {
        value: value.to_owned(),
        label: label.to_owned(),
        detail: Some(detail.to_owned()),
        disabled,
    }
}

/// 동적 실행설정 값의 허용 규칙. 값은 이 규칙을 통과해야만 CLI 인자로 변환된다.
enum DynamicValueRule {
    /// 모델·에이전트 식별자 문자 집합(normalize_model과 동일)
    Identifier,
    /// 고정 선택지 중 하나
    #[allow(dead_code)]
    OneOf(&'static [&'static str]),
}

struct DynamicSettingSpec {
    key: &'static str,
    flag: &'static str,
    rule: DynamicValueRule,
}

/// provider별로 CLI 전달이 허용된 동적 설정 목록. 이 화이트리스트에 없는 항목은
/// 스키마(디스커버리)가 무엇을 제안하든 절대 CLI 인자가 되지 않는다.
fn provider_dynamic_setting_specs(source: ProviderId) -> &'static [DynamicSettingSpec] {
    match source {
        ProviderId::Claude => &[DynamicSettingSpec {
            key: "fallbackModel",
            flag: "--fallback-model",
            rule: DynamicValueRule::Identifier,
        }],
        ProviderId::Codex | ProviderId::Antigravity => &[],
    }
}

pub(crate) fn identifier_value_is_valid(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':' | b'/')
        })
}

/// 시작 요청의 동적 설정을 화이트리스트로 검증한다. 모르는 키나 규칙에 어긋난 값은
/// 조용히 버리지 않고 오류로 돌려보내 UI/AIA 쪽 스키마 불일치를 즉시 드러낸다.
fn validate_dynamic_settings(
    source: ProviderId,
    settings: &BTreeMap<String, String>,
) -> Result<BTreeMap<String, String>, CoreError> {
    let specs = provider_dynamic_setting_specs(source);
    let mut validated = BTreeMap::new();
    for (key, value) in settings {
        let value = value.trim();
        if value.is_empty() {
            continue;
        }
        let Some(spec) = specs.iter().find(|spec| spec.key == key) else {
            return Err(CoreError::InvalidInput(format!(
                "지원하지 않는 실행설정 항목입니다: {key}"
            )));
        };
        let valid = match spec.rule {
            DynamicValueRule::Identifier => identifier_value_is_valid(value),
            DynamicValueRule::OneOf(allowed) => allowed.contains(&value),
        };
        if !valid {
            return Err(CoreError::InvalidInput(format!(
                "실행설정 값이 올바르지 않습니다: {key}"
            )));
        }
        validated.insert(key.clone(), value.to_owned());
    }
    Ok(validated)
}

fn dynamic_setting_args(source: ProviderId, settings: &BTreeMap<String, String>) -> Vec<String> {
    let specs = provider_dynamic_setting_specs(source);
    let mut args = Vec::new();
    for (key, value) in settings {
        if let Some(spec) = specs.iter().find(|spec| spec.key == key) {
            args.push(spec.flag.to_owned());
            args.push(value.clone());
        }
    }
    args
}

/// AIA 디스커버리가 제안한 실행설정 스키마의 저장 파일. 내장 스키마 위에 덧입힌다.
const CHAT_SETTINGS_SCHEMA_FILE: &str = "chat-settings-schema-v1.json";

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChatSettingsSchemaOverrides {
    #[serde(default)]
    providers: BTreeMap<String, Vec<ChatSettingField>>,
    #[serde(default)]
    updated_at: i64,
}

fn schema_overrides_path(app_data_dir: &std::path::Path) -> PathBuf {
    app_data_dir.join(CHAT_SETTINGS_SCHEMA_FILE)
}

fn load_schema_overrides(app_data_dir: &std::path::Path) -> ChatSettingsSchemaOverrides {
    fs::read(schema_overrides_path(app_data_dir))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn schema_overrides_updated_at(app_data_dir: Option<&std::path::Path>) -> Option<i64> {
    let updated_at = load_schema_overrides(app_data_dir?).updated_at;
    (updated_at > 0).then_some(updated_at)
}

/// 제안된 스키마 필드를 검증한다. 내장 항목은 선택지 값이 내장 값의 부분집합일 때만
/// (재라벨·재배열·숨김) 허용하고, 새 항목은 동적 화이트리스트에 있어야 한다.
/// AI가 생성한 스키마가 임의 CLI 플래그나 표시 폭주로 이어지지 않게 막는 신뢰 경계다.
fn validate_schema_fields(
    source: ProviderId,
    fields: &[ChatSettingField],
) -> Result<(), CoreError> {
    let invalid = |message: &str| {
        Err(CoreError::InvalidInput(format!(
            "실행설정 스키마 검증 실패: {message}"
        )))
    };
    if fields.len() > 24 {
        return invalid("항목이 24개를 넘습니다");
    }
    let builtin = provider_setting_fields(source);
    let specs = provider_dynamic_setting_specs(source);
    let mut seen = HashSet::new();
    for field in fields {
        if field.key.is_empty() || field.key.len() > 40 || !seen.insert(field.key.clone()) {
            return invalid("항목 키가 비었거나 중복됩니다");
        }
        if field.label.is_empty() || field.label.chars().count() > 40 {
            return invalid("항목 라벨 길이가 잘못됐습니다");
        }
        if field
            .detail
            .as_deref()
            .is_some_and(|detail| detail.chars().count() > 120)
        {
            return invalid("항목 설명이 너무 깁니다");
        }
        if field.options.len() > 12 {
            return invalid("선택지가 12개를 넘습니다");
        }
        for option in &field.options {
            if option.value.is_empty()
                || option.value.len() > 128
                || option.label.is_empty()
                || option.label.chars().count() > 40
                || option
                    .detail
                    .as_deref()
                    .is_some_and(|detail| detail.chars().count() > 120)
            {
                return invalid("선택지 값 또는 라벨이 잘못됐습니다");
            }
        }
        // 동적 화이트리스트 항목(내장 여부와 무관)은 해당 값 규칙으로,
        // 그 외 내장 enum 항목(mode·approvalMode)은 내장 값 부분집합 규칙으로 검증한다.
        if let Some(spec) = specs.iter().find(|spec| spec.key == field.key) {
            let rule_ok = |value: &str| match spec.rule {
                DynamicValueRule::Identifier => identifier_value_is_valid(value),
                DynamicValueRule::OneOf(allowed) => allowed.contains(&value),
            };
            for option in &field.options {
                if !rule_ok(&option.value) {
                    return invalid("동적 항목 선택지 값이 규칙에 어긋납니다");
                }
            }
            if let Some(default) = &field.default_value {
                if !rule_ok(default) {
                    return invalid("동적 항목 기본값이 규칙에 어긋납니다");
                }
            }
        } else if let Some(builtin_field) =
            builtin.iter().find(|candidate| candidate.key == field.key)
        {
            if field.options.is_empty() {
                return invalid("내장 항목의 선택지가 비었습니다");
            }
            for option in &field.options {
                if !builtin_field
                    .options
                    .iter()
                    .any(|allowed| allowed.value == option.value)
                {
                    return invalid("내장 항목에 허용되지 않은 선택지 값이 있습니다");
                }
            }
            if let Some(default) = &field.default_value {
                if !field.options.iter().any(|option| &option.value == default) {
                    return invalid("기본값이 선택지에 없습니다");
                }
            }
        } else {
            return invalid("동적 화이트리스트에 없는 항목입니다");
        }
    }
    Ok(())
}

/// 내장 스키마에 저장된 오버라이드를 덧입힌다. 저장 시점에 검증했더라도
/// 파일이 외부에서 바뀔 수 있으므로 로드 때 다시 검증하고, 실패하면 내장 스키마로 폴백한다.
fn merged_setting_fields(
    source: ProviderId,
    app_data_dir: Option<&std::path::Path>,
) -> Vec<ChatSettingField> {
    let base = provider_setting_fields(source);
    let Some(app_data_dir) = app_data_dir else {
        return base;
    };
    let overrides = load_schema_overrides(app_data_dir);
    let Some(fields) = overrides.providers.get(source.as_str()) else {
        return base;
    };
    if validate_schema_fields(source, fields).is_err() {
        return base;
    }
    let mut merged = base;
    for field in fields {
        if let Some(existing) = merged
            .iter_mut()
            .find(|candidate| candidate.key == field.key)
        {
            *existing = field.clone();
        } else {
            merged.push(field.clone());
        }
    }
    merged
}

/// 실행설정 항목 스키마. 프론트는 이 목록을 그대로 렌더링하므로,
/// 항목·선택지를 바꾸면 UI가 함께 바뀐다. 프론트 fallbackSettingFields와 내용을 맞출 것.
fn provider_setting_fields(source: ProviderId) -> Vec<ChatSettingField> {
    let codex = source == ProviderId::Codex;
    let mut fields = vec![
        ChatSettingField {
            key: "mode".to_owned(),
            label: "실행 모드".to_owned(),
            detail: Some("권한 범위".to_owned()),
            kind: ChatSettingFieldKind::Enum,
            options: vec![
                setting_option("plan", "읽기 전용", "분석·계획만", false),
                setting_option("workspace", "작업공간 쓰기", "프로젝트 수정", false),
                setting_option("fullAccess", "전체 접근", "외부 경로 허용", false),
            ],
            default_value: Some("workspace".to_owned()),
        },
        ChatSettingField {
            key: "approvalMode".to_owned(),
            label: "승인 처리".to_owned(),
            detail: Some("명령 · 파일 · 추가 권한".to_owned()),
            kind: ChatSettingFieldKind::Enum,
            options: vec![
                setting_option("manual", "직접 승인", "사용자 확인", false),
                if codex {
                    setting_option("autoReview", "자동 검토", "위험도 판단", false)
                } else {
                    setting_option("autoReview", "자동 검토", "Codex 전용", true)
                },
                setting_option("never", "승인 없이 실행", "모드 범위 내", false),
            ],
            default_value: Some(if codex { "autoReview" } else { "manual" }.to_owned()),
        },
    ];
    // 화이트리스트에 등록된 동적 항목을 스키마에 노출한다. Claude --fallback-model이 첫 사례.
    if source == ProviderId::Claude {
        fields.push(ChatSettingField {
            key: "fallbackModel".to_owned(),
            label: "예비 모델".to_owned(),
            detail: Some("기본 모델 과부하 시 자동 전환".to_owned()),
            kind: ChatSettingFieldKind::Text,
            options: Vec::new(),
            default_value: None,
        });
    }
    fields
}

fn load_codex_model_catalog(
    executable: &std::path::Path,
) -> Result<Vec<ChatModelOption>, CoreError> {
    let mut command = Command::new(executable);
    command
        .args(["app-server", "--stdio"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    configure_headless_command(&mut command);
    let mut child = command.spawn().map_err(|error| {
        CoreError::Runtime(format!("Codex 모델 목록을 시작하지 못했습니다: {error}"))
    })?;
    let result = (|| {
        let mut stdin = child.stdin.take().ok_or_else(|| {
            CoreError::Runtime("Codex 모델 목록 stdin을 열지 못했습니다".to_owned())
        })?;
        let stdout = child.stdout.take().ok_or_else(|| {
            CoreError::Runtime("Codex 모델 목록 stdout을 열지 못했습니다".to_owned())
        })?;
        let mut reader = BufReader::new(stdout);
        write_json_line(
            &mut stdin,
            &json!({
                "id": 1,
                "method": "initialize",
                "params": {
                    "clientInfo": {"name": "agent-manager", "title": "Agent Manager", "version": env!("CARGO_PKG_VERSION")},
                    "capabilities": {"experimentalApi": true}
                }
            }),
        )?;
        read_rpc_result(&mut reader, 1)?;
        write_json_line(&mut stdin, &json!({"method": "initialized"}))?;

        let mut models = Vec::new();
        let mut cursor: Option<String> = None;
        for request_id in 2..=5 {
            write_json_line(
                &mut stdin,
                &json!({
                    "id": request_id,
                    "method": "model/list",
                    "params": {"cursor": cursor, "includeHidden": false}
                }),
            )?;
            let page = read_rpc_result(&mut reader, request_id)?;
            if let Some(items) = page.get("data").and_then(Value::as_array) {
                models.extend(items.iter().filter_map(parse_codex_model));
            }
            cursor = page
                .get("nextCursor")
                .and_then(Value::as_str)
                .map(str::to_owned);
            if cursor.is_none() {
                break;
            }
        }
        Ok(models)
    })();
    let _ = child.kill();
    let _ = child.wait();
    result
}

fn parse_codex_model(value: &Value) -> Option<ChatModelOption> {
    let model = value.get("model")?.as_str()?.to_owned();
    let supported_reasoning_efforts = value
        .get("supportedReasoningEfforts")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|option| {
            let effort = ReasoningEffort::parse(option.get("reasoningEffort")?.as_str()?)?;
            Some(ChatReasoningOption {
                effort,
                description: option
                    .get("description")
                    .and_then(Value::as_str)
                    .unwrap_or_else(|| effort_description(effort))
                    .to_owned(),
            })
        })
        .collect();
    Some(ChatModelOption {
        display_name: value
            .get("displayName")
            .and_then(Value::as_str)
            .unwrap_or(&model)
            .to_owned(),
        description: value
            .get("description")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        is_default: value
            .get("isDefault")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        default_reasoning_effort: value
            .get("defaultReasoningEffort")
            .and_then(Value::as_str)
            .and_then(ReasoningEffort::parse),
        supported_reasoning_efforts,
        model,
    })
}

impl Drop for SupervisorInner {
    fn drop(&mut self) {
        if let Ok(chats) = self.chats.lock() {
            for chat in chats.values() {
                let _ = chat.stop();
            }
        }
    }
}

/// 에이전트 오류 메시지가 사용량·요청 제한을 뜻하는지 보수적으로 판별한다.
/// 오탐이 실행 중 세션을 종료시키는 자동전환으로 이어지므로 Error 이벤트의
/// 대표적인 제한 문구에만 반응한다.
fn is_usage_limit_message(message: &str) -> bool {
    let normalized = message.to_ascii_lowercase();
    [
        "usage limit",
        "rate limit",
        "rate-limit",
        "limit reached",
        "too many requests",
        "quota exceeded",
        "out of quota",
    ]
    .iter()
    .any(|marker| normalized.contains(marker))
}

impl ChatRuntime {
    fn attachment_root(&self) -> Result<PathBuf, CoreError> {
        let app_data_dir = self.app_data_dir.as_ref().ok_or_else(|| {
            CoreError::Runtime("첨부 파일 저장소가 준비되지 않았습니다".to_owned())
        })?;
        let root = app_data_dir.join("chat-inputs").join(&self.chat_id);
        fs::create_dir_all(&root)?;
        let root = fs::canonicalize(root)?;
        if !root.starts_with(fs::canonicalize(app_data_dir)?) {
            return Err(CoreError::InvalidInput(
                "첨부 파일 저장 경로가 앱 데이터 범위를 벗어났습니다".to_owned(),
            ));
        }
        Ok(root)
    }

    fn upload_input_file(
        &self,
        name: &str,
        media_type: &str,
        bytes: Vec<u8>,
    ) -> Result<ChatInputFile, CoreError> {
        let name = validate_input_file_name(name)?;
        if bytes.is_empty() {
            return Err(CoreError::InvalidInput(
                "빈 파일은 첨부할 수 없습니다".to_owned(),
            ));
        }
        if bytes.len() > MAX_CHAT_INPUT_FILE_BYTES {
            return Err(CoreError::TooLarge(MAX_CHAT_INPUT_FILE_BYTES as u64));
        }
        let detected_image = detected_image_media_type(&bytes);
        if detected_image.is_some() && bytes.len() > MAX_CHAT_INPUT_IMAGE_BYTES {
            return Err(CoreError::TooLarge(MAX_CHAT_INPUT_IMAGE_BYTES as u64));
        }
        let media_type = detected_image
            .unwrap_or_else(|| normalize_media_type(media_type))
            .to_owned();
        let kind = if detected_image.is_some() {
            ChatInputFileKind::Image
        } else {
            ChatInputFileKind::File
        };
        let id = Uuid::new_v4().to_string();
        let root = self.attachment_root()?;
        let path = root.join(format!("{id}.upload"));
        fs::write(&path, &bytes)?;
        let path = fs::canonicalize(&path)?;
        if !path.starts_with(&root) {
            let _ = fs::remove_file(&path);
            return Err(CoreError::InvalidInput(
                "첨부 파일 경로가 저장소 범위를 벗어났습니다".to_owned(),
            ));
        }
        let file = ChatInputFile {
            id: id.clone(),
            name,
            media_type,
            size_bytes: bytes.len(),
            kind,
        };
        lock(&self.state)?.uploads.insert(
            id,
            StoredChatInputFile {
                file: file.clone(),
                path,
                used: false,
            },
        );
        Ok(file)
    }

    fn input_file_download(&self, attachment_id: &str) -> Result<ChatInputFileDownload, CoreError> {
        let stored = lock(&self.state)?
            .uploads
            .get(attachment_id)
            .cloned()
            .ok_or_else(|| CoreError::NotFound("첨부 파일을 찾을 수 없습니다".to_owned()))?;
        let root = self.attachment_root()?;
        let path = fs::canonicalize(&stored.path)?;
        if !path.starts_with(&root) {
            return Err(CoreError::InvalidInput(
                "첨부 파일 경로가 저장소 범위를 벗어났습니다".to_owned(),
            ));
        }
        Ok(ChatInputFileDownload {
            file: stored.file,
            bytes: fs::read(path)?,
        })
    }

    fn remove_input_file(&self, attachment_id: &str) -> Result<(), CoreError> {
        let stored = {
            let mut state = lock(&self.state)?;
            let stored = state
                .uploads
                .get(attachment_id)
                .ok_or_else(|| CoreError::NotFound("첨부 파일을 찾을 수 없습니다".to_owned()))?;
            if stored.used {
                return Err(CoreError::Conflict(
                    "이미 전송한 첨부 파일은 대화 기록 보호를 위해 삭제할 수 없습니다".to_owned(),
                ));
            }
            state.uploads.remove(attachment_id).expect("checked upload")
        };
        let root = self.attachment_root()?;
        let path = fs::canonicalize(&stored.path)?;
        if !path.starts_with(&root) {
            return Err(CoreError::InvalidInput(
                "첨부 파일 경로가 저장소 범위를 벗어났습니다".to_owned(),
            ));
        }
        fs::remove_file(path)?;
        Ok(())
    }

    fn attach(&self) -> Result<ChatAttachment, CoreError> {
        let mut state = lock(&self.state)?;
        // 마지막에 연결한 화면이 이긴다. 기존 구독자(살아 있는 다른 화면이거나,
        // 비정상 종료 후 heartbeat 실패 전까지 남는 죽은 소켓)에는 재연결을
        // 멈추라는 신호를 보내고 구독을 교체한다.
        if let Some(previous) = state.subscriber.take() {
            let _ = previous.try_send(ChatEvent::TakenOver);
        }
        let info = self.info_from(&state);
        let pending_events = self.attention.pending_events(&self.chat_id);
        // 리플레이 전체와 대기 이벤트를 모두 담고도 라이브 이벤트 여유가 남게 잡아
        // 재연결 시 대화 앞부분(첫 사용자 메시지)이 잘리지 않도록 한다.
        let (sender, receiver) =
            mpsc::sync_channel(state.replay.len() + pending_events.len() + EVENT_QUEUE_CAPACITY);
        let mut replayed_approvals = HashSet::new();
        for event in state.replay.iter() {
            if let ChatEvent::Approval { id, .. } = event {
                replayed_approvals.insert(id.clone());
            }
            if sender.try_send(event.clone()).is_err() {
                break;
            }
        }
        for event in pending_events {
            let already_replayed = matches!(
                &event,
                ChatEvent::Approval { id, .. } if replayed_approvals.contains(id)
            );
            if !already_replayed && sender.try_send(event).is_err() {
                break;
            }
        }
        sender
            .try_send(ChatEvent::State {
                session: info.clone(),
            })
            .map_err(|_| CoreError::Runtime("채팅 이벤트 채널을 열지 못했습니다".to_owned()))?;
        state.subscriber = Some(sender);
        state.subscriber_generation += 1;
        Ok(ChatAttachment {
            info,
            events: receiver,
            generation: state.subscriber_generation,
        })
    }

    fn send(
        self: &Arc<Self>,
        text: &str,
        attachment_ids: &[String],
        steer: bool,
        allow_queue: bool,
    ) -> Result<ChatSendOutcome, CoreError> {
        enum SendAction {
            Start(String, PendingChatMessage),
            Queued(String, Vec<QueuedChatMessage>),
        }
        let action = {
            let mut state = lock(&self.state)?;
            let attachments = resolve_input_files(&state, attachment_ids)?;
            let message = PendingChatMessage {
                id: format!("queued-{}", Uuid::new_v4()),
                text: text.to_owned(),
                attachments,
            };
            match state.phase {
                ChatPhase::Stopped | ChatPhase::Failed => {
                    return Err(CoreError::Conflict(
                        "채팅이 종료되어 메시지를 보낼 수 없습니다. 새 채팅을 시작하세요"
                            .to_owned(),
                    ));
                }
                ChatPhase::Ready if state.queue.is_empty() => {
                    mark_input_files_used(&mut state, attachment_ids);
                    SendAction::Start(claim_turn(&mut state), message)
                }
                _ => {
                    if !allow_queue {
                        return Err(CoreError::Conflict(
                            "채팅이 실행 중이거나 대기열이 있어 즉시 전송할 수 없습니다".to_owned(),
                        ));
                    }
                    if state.queue.len() >= MAX_QUEUED_MESSAGES {
                        return Err(CoreError::Conflict(
                            "대기열이 가득 찼습니다. 대기 중인 메시지를 정리한 뒤 다시 시도하세요"
                                .to_owned(),
                        ));
                    }
                    mark_input_files_used(&mut state, attachment_ids);
                    let message_id = message.id.clone();
                    if steer {
                        state.queue.push_front(message);
                    } else {
                        state.queue.push_back(message);
                    }
                    SendAction::Queued(message_id, queue_items(&state))
                }
            }
        };
        match action {
            SendAction::Start(turn_id, message) => {
                self.run_claimed_turn(&message, &turn_id)?;
                Ok(ChatSendOutcome::Started(turn_id))
            }
            SendAction::Queued(message_id, items) => {
                self.emit(ChatEvent::Queue { items });
                if steer {
                    // 대기열 맨 앞에 넣은 메시지가 바로 이어지도록 현재 턴을 중단한다.
                    let _ = self.interrupt();
                }
                self.drain_queue();
                Ok(ChatSendOutcome::Queued(message_id))
            }
        }
    }

    fn confirm_started_turn(&self, local_turn_id: &str) -> Result<String, CoreError> {
        if self.source != ProviderId::Codex {
            let state = lock(&self.state)?;
            if state.active_turn_id.as_deref() == Some(local_turn_id)
                && matches!(state.phase, ChatPhase::Running | ChatPhase::WaitingApproval)
            {
                return Ok(local_turn_id.to_owned());
            }
            return Err(CoreError::Runtime(
                "채팅의 새 턴 시작을 확인하지 못했습니다".to_owned(),
            ));
        }

        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            {
                let state = lock(&self.state)?;
                if let Some(turn_id) = &state.current_turn_id {
                    return Ok(turn_id.clone());
                }
                if !matches!(state.phase, ChatPhase::Running | ChatPhase::WaitingApproval)
                    || state.active_turn_id.as_deref() != Some(local_turn_id)
                {
                    return Err(CoreError::Runtime(
                        "Codex가 새 턴을 생성하지 않았습니다".to_owned(),
                    ));
                }
            }
            if Instant::now() >= deadline {
                return Err(CoreError::Runtime(
                    "Codex 새 턴 생성 확인 시간이 초과되었습니다".to_owned(),
                ));
            }
            thread::sleep(Duration::from_millis(20));
        }
    }

    fn run_claimed_turn(
        self: &Arc<Self>,
        message: &PendingChatMessage,
        turn_id: &str,
    ) -> Result<(), CoreError> {
        self.emit(ChatEvent::Turn {
            id: turn_id.to_owned(),
            status: "started".to_owned(),
            timestamp: now_ms(),
        });
        self.emit(ChatEvent::UserInput {
            id: format!("user-{}", Uuid::new_v4()),
            text: message.text.clone(),
            attachments: message
                .attachments
                .iter()
                .map(|attachment| attachment.file.clone())
                .collect(),
        });
        self.emit_state();

        let result = match self.source {
            ProviderId::Codex => self.send_codex_turn(message),
            ProviderId::Claude => self.send_claude_turn(message),
            ProviderId::Antigravity => spawn_stream_cli(self, message),
        };
        if let Err(error) = result {
            if let Ok(mut state) = self.state.lock() {
                state.turn_count = state.turn_count.saturating_sub(1);
                state.phase = ChatPhase::Ready;
            }
            self.emit_state();
            self.emit(ChatEvent::Error {
                message: error.to_string(),
            });
            self.emit_turn("failed");
            return Err(error);
        }
        Ok(())
    }

    fn drain_queue(self: &Arc<Self>) {
        let (message, turn_id, items) = {
            let mut state = match self.state.lock() {
                Ok(state) => state,
                Err(_) => return,
            };
            if state.phase != ChatPhase::Ready {
                return;
            }
            let Some(message) = state.queue.pop_front() else {
                return;
            };
            // 팝과 페이즈 점유를 한 잠금에서 처리해 동시 드레인이 순서를 깨지 못하게 한다.
            let turn_id = claim_turn(&mut state);
            let items = queue_items(&state);
            (message, turn_id, items)
        };
        self.emit(ChatEvent::Queue { items });
        if self.run_claimed_turn(&message, &turn_id).is_err() {
            // 시작하지 못한 메시지는 정리하거나 다시 보낼 수 있게 대기열 맨 앞으로 되돌린다.
            if let Ok(mut state) = self.state.lock() {
                state.queue.push_front(message);
                let items = queue_items(&state);
                drop(state);
                self.emit(ChatEvent::Queue { items });
            }
        }
    }

    fn remove_queued(&self, message_id: &str) -> Result<(), CoreError> {
        let items = {
            let mut state = lock(&self.state)?;
            state.queue.retain(|message| message.id != message_id);
            queue_items(&state)
        };
        self.emit(ChatEvent::Queue { items });
        Ok(())
    }

    fn cancel_pending_approvals(&self) {
        let pending = match self.state.lock() {
            Ok(mut state) => state.pending_approvals.drain().collect::<Vec<_>>(),
            Err(_) => return,
        };
        for (approval_id, approval) in pending {
            let _ = self.write_json(&approval_response(&approval, ChatApprovalDecision::Cancel));
            self.emit(ChatEvent::ApprovalResolved {
                id: approval_id,
                decision: ChatApprovalDecision::Cancel,
            });
        }
    }

    fn discard_pending_approvals(&self) {
        let pending = match self.state.lock() {
            Ok(mut state) => state.pending_approvals.drain().collect::<Vec<_>>(),
            Err(_) => return,
        };
        for (approval_id, _) in pending {
            self.emit(ChatEvent::ApprovalResolved {
                id: approval_id,
                decision: ChatApprovalDecision::Cancel,
            });
        }
    }

    fn send_codex_turn(&self, message: &PendingChatMessage) -> Result<(), CoreError> {
        let (request_id, thread_id) = {
            let mut state = lock(&self.state)?;
            let request_id = state.next_request_id;
            state.next_request_id = state.next_request_id.saturating_add(1);
            let thread_id = state.provider_session_id.clone().ok_or_else(|| {
                CoreError::Runtime("Codex 스레드가 초기화되지 않았습니다".to_owned())
            })?;
            (request_id, thread_id)
        };
        let input = codex_turn_input(message);
        let mut params = json!({
            "threadId": thread_id,
            "input": input,
            "cwd": self.cwd,
        });
        if self.profile == ChatProfile::Aia {
            params["sandboxPolicy"] = workspace_write_sandbox_policy(&aia_workspace_roots(self));
        }
        if let Some(effort) = self.reasoning_effort {
            params["effort"] = Value::String(effort.as_str().to_owned());
        }
        self.write_json(&json!({
            "id": request_id,
            "method": "turn/start",
            "params": params,
        }))
    }

    fn send_claude_turn(&self, message: &PendingChatMessage) -> Result<(), CoreError> {
        self.write_json(&claude_user_message(message)?)
    }

    fn approve(&self, approval_id: &str, decision: ChatApprovalDecision) -> Result<(), CoreError> {
        if !matches!(self.source, ProviderId::Codex | ProviderId::Claude) {
            return Err(CoreError::InvalidInput(
                "이 공급자의 구조화 모드는 대화형 승인을 지원하지 않습니다".to_owned(),
            ));
        }
        let pending = {
            let mut state = lock(&self.state)?;
            state
                .pending_approvals
                .remove(approval_id)
                .ok_or_else(|| CoreError::NotFound("승인 요청을 찾을 수 없습니다".to_owned()))?
        };
        if let Err(error) = self.write_json(&approval_response(&pending, decision)) {
            if let Ok(mut state) = self.state.lock() {
                state
                    .pending_approvals
                    .insert(approval_id.to_owned(), pending);
            }
            return Err(error);
        }
        let phase = self
            .state
            .lock()
            .map(|mut state| {
                // 취소는 deny+interrupt로 전송되므로, 뒤따르는 result(is_error)를
                // CLI 실패가 아닌 사용자 중단으로 판정할 수 있게 플래그를 세운다.
                if self.source == ProviderId::Claude && decision == ChatApprovalDecision::Cancel {
                    state.claude_interrupt_pending = true;
                }
                if state.pending_approvals.is_empty() {
                    ChatPhase::Running
                } else {
                    ChatPhase::WaitingApproval
                }
            })
            .unwrap_or(ChatPhase::Running);
        self.set_phase(phase);
        self.emit(ChatEvent::ApprovalResolved {
            id: approval_id.to_owned(),
            decision,
        });
        Ok(())
    }

    fn interrupt(&self) -> Result<(), CoreError> {
        if self.source == ProviderId::Codex {
            let (request_id, thread_id, turn_id) = {
                let mut state = lock(&self.state)?;
                let request_id = state.next_request_id;
                state.next_request_id = state.next_request_id.saturating_add(1);
                let thread_id = state.provider_session_id.clone().ok_or_else(|| {
                    CoreError::Runtime("Codex 스레드가 초기화되지 않았습니다".to_owned())
                })?;
                let turn_id = state
                    .current_turn_id
                    .clone()
                    .ok_or_else(|| CoreError::Conflict("중단할 활성 턴이 없습니다".to_owned()))?;
                (request_id, thread_id, turn_id)
            };
            return self.write_json(&json!({
                "id": request_id,
                "method": "turn/interrupt",
                "params": {"threadId": thread_id, "turnId": turn_id},
            }));
        }
        if self.source == ProviderId::Claude {
            let request_id = {
                let mut state = lock(&self.state)?;
                if !matches!(state.phase, ChatPhase::Running | ChatPhase::WaitingApproval) {
                    return Err(CoreError::Conflict("중단할 활성 턴이 없습니다".to_owned()));
                }
                state.claude_interrupt_pending = true;
                format!("interrupt-{}", Uuid::new_v4())
            };
            let result = self.write_json(&claude_control_request(&request_id, "interrupt"));
            if result.is_err() {
                if let Ok(mut state) = self.state.lock() {
                    state.claude_interrupt_pending = false;
                }
            }
            return result;
        }
        let mut child = lock(&self.child)?;
        if let Some(child) = child.as_mut() {
            child.kill().map_err(|error| {
                CoreError::Runtime(format!("채팅 실행을 중단하지 못했습니다: {error}"))
            })?;
            return Ok(());
        }
        Err(CoreError::Conflict("중단할 활성 턴이 없습니다".to_owned()))
    }

    fn detach(&self) -> Result<(), CoreError> {
        lock(&self.state)?.subscriber = None;
        Ok(())
    }

    /// 세대가 일치할 때만 구독을 분리한다. takeover로 이미 다른 화면이
    /// 구독을 가져갔다면 옛 연결의 정리는 아무것도 하지 않는다.
    fn detach_attachment(&self, generation: u64) -> Result<(), CoreError> {
        let mut state = lock(&self.state)?;
        if state.subscriber_generation == generation {
            state.subscriber = None;
        }
        Ok(())
    }

    /// 실행 프로세스와 대기열, 승인 요청, 계정 lease를 정리한다.
    /// 정리는 끝까지 진행하되 프로세스 종료를 확인하지 못한 실패는 숨기지 않고 반환한다.
    fn stop(&self) -> Result<(), CoreError> {
        self.stop_internal(false).map(|_| ())
    }

    /// 정상 종료를 먼저 시도하고, 종료 신호 전송·확인이 실패하면 PID 기반
    /// SIGKILL 강제 종료로 승격한다. `Ok(true)`는 강제 종료로 승격해 종료를
    /// 확인했음을 뜻한다. 강제 종료까지 실패하면 오류를 반환하되 프로세스
    /// 핸들은 다음 재시도가 다시 쓸 수 있게 유지한다.
    fn stop_with_escalation(&self) -> Result<bool, CoreError> {
        self.stop_internal(true)
    }

    fn stop_internal(&self, force: bool) -> Result<bool, CoreError> {
        let mut failures: Vec<String> = Vec::new();
        let mut forced = false;
        self.cancel_pending_approvals();
        let slot = match self.child.lock() {
            Ok(slot) => Some(slot),
            // 강제 모드에서는 잠금 오염을 복구해 프로세스 종료를 계속 진행한다.
            Err(poison) if force => Some(poison.into_inner()),
            Err(_) => {
                failures.push("프로세스 잠금이 손상되었습니다".to_owned());
                None
            }
        };
        if let Some(mut slot) = slot {
            if let Some(mut child) = slot.take() {
                let pid = child.id();
                let mut errors: Vec<String> = Vec::new();
                let kill_error = child.kill().err();
                if let Some(error) = &kill_error {
                    errors.push(format!("프로세스 종료 신호를 보내지 못했습니다: {error}"));
                    if force {
                        // 살아 있는 프로세스를 wait가 무한 대기하지 않도록 SIGKILL을 먼저 보장한다.
                        send_sigkill(pid);
                    }
                }
                let mut terminated = false;
                if kill_error.is_none() || force {
                    match child.wait() {
                        Ok(_) => {
                            terminated = true;
                            errors.clear();
                        }
                        Err(error) => {
                            errors.push(format!("프로세스 종료를 확인하지 못했습니다: {error}"))
                        }
                    }
                }
                if !terminated && force {
                    match ensure_pid_terminated(pid) {
                        Ok(()) => {
                            terminated = true;
                            forced = true;
                            errors.clear();
                        }
                        Err(error) => errors.push(format!("강제 종료에 실패했습니다: {error}")),
                    }
                }
                if !terminated {
                    // 다음 종료 재시도가 같은 프로세스 핸들을 쓸 수 있게 되돌린다.
                    *slot = Some(child);
                }
                failures.extend(errors);
            }
        }
        if let Ok(mut stdin) = self.stdin.lock() {
            *stdin = None;
        }
        let had_queue = self
            .state
            .lock()
            .map(|mut state| {
                let had_queue = !state.queue.is_empty();
                state.queue.clear();
                state.claude_interrupt_pending = false;
                had_queue
            })
            .unwrap_or(false);
        self.set_phase(ChatPhase::Stopped);
        self.release_account_runtime();
        if had_queue {
            self.emit(ChatEvent::Queue { items: Vec::new() });
        }
        if failures.is_empty() {
            Ok(forced)
        } else {
            Err(CoreError::Runtime(format!(
                "채팅 {}을(를) 완전히 종료하지 못했습니다: {}",
                self.chat_id,
                failures.join("; ")
            )))
        }
    }

    fn write_json(&self, value: &Value) -> Result<(), CoreError> {
        let mut stdin = lock(&self.stdin)?;
        let stdin = stdin.as_mut().ok_or_else(|| {
            CoreError::Runtime("구조화 채팅 프로세스가 실행 중이 아닙니다".to_owned())
        })?;
        serde_json::to_writer(&mut *stdin, value)?;
        stdin.write_all(b"\n")?;
        stdin.flush()?;
        Ok(())
    }

    fn set_phase(&self, phase: ChatPhase) {
        if let Ok(mut state) = self.state.lock() {
            state.phase = phase;
            if phase != ChatPhase::Running && phase != ChatPhase::WaitingApproval {
                state.current_turn_id = None;
            }
        }
        self.emit_state();
    }

    fn emit_turn(&self, status: impl Into<String>) {
        let status = status.into();
        let turn_id = self
            .state
            .lock()
            .ok()
            .and_then(|state| state.active_turn_id.clone())
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        self.emit(ChatEvent::Turn {
            id: turn_id,
            status: status.clone(),
            timestamp: now_ms(),
        });
        if status != "started" {
            if let Ok(mut state) = self.state.lock() {
                state.active_turn_id = None;
            }
        }
    }

    fn update_provider_session_id(&self, session_id: &str) {
        if session_id.is_empty() {
            return;
        }
        if let Ok(mut state) = self.state.lock() {
            state.provider_session_id = Some(session_id.to_owned());
        }
        self.persist_session_metadata(session_id);
        self.emit_state();
    }

    /// 세션 ID가 확정되면 이 실행의 메타데이터를 남긴다. 실패해도 채팅은 계속한다.
    fn persist_session_metadata(&self, session_id: &str) {
        if let Some(app_data_dir) = &self.app_data_dir {
            let _ = store::persist_session_runtime_settings(
                app_data_dir,
                self.source,
                session_id,
                self.reasoning_effort,
                self.mode,
                self.approval_mode,
            );
            if !self.resuming {
                let _ = store::persist_session_creation_account_id(
                    app_data_dir,
                    self.source,
                    session_id,
                    self.account_id.as_deref(),
                );
            }
        }
    }

    fn emit_state(&self) {
        if let Ok(state) = self.state.lock() {
            let event = ChatEvent::State {
                session: self.info_from(&state),
            };
            drop(state);
            self.emit(event);
        }
    }

    fn info_from(&self, state: &RuntimeState) -> ChatSessionInfo {
        ChatSessionInfo {
            chat_id: self.chat_id.clone(),
            started_at: self.started_at,
            source: self.source,
            account_id: self.account_id.clone(),
            resuming: self.resuming,
            provider_session_id: state.provider_session_id.clone(),
            cwd: self.cwd.to_string_lossy().into_owned(),
            model: self.model.clone(),
            reasoning_effort: self.reasoning_effort,
            mode: self.mode,
            approval_mode: self.approval_mode,
            state: state.phase,
            turn_count: state.turn_count,
            last_turn_status: state.last_turn_status.clone(),
            unattended: self.unattended,
            attached: state.subscriber.is_some(),
            interactive_approvals: self.approval_mode == ChatApprovalMode::Manual
                && !self.unattended
                && matches!(self.source, ProviderId::Codex | ProviderId::Claude),
            profile: self.profile,
            system_tools: self.profile == ChatProfile::Aia
                && provider_supports_aia_system_mcp(self.source),
            settings: self.dynamic_settings.clone(),
        }
    }

    fn release_account_runtime(&self) {
        if let Ok(mut lease) = self.account_runtime_lease.lock() {
            if let Some(mut lease) = lease.take() {
                lease.release();
            }
        }
    }

    fn emit(&self, event: ChatEvent) {
        let mut state = match self.state.lock() {
            Ok(state) => state,
            Err(_) => return,
        };
        let captured = match &event {
            ChatEvent::MessageDelta {
                role, kind, delta, ..
            } if role == "assistant" && kind == "message" => {
                append_captured_output(&mut state.assistant_output, delta);
                None
            }
            ChatEvent::Turn {
                id,
                status,
                timestamp,
            } if status == "completed" => {
                let session_id = state.provider_session_id.clone();
                if state.assistant_output.trim().is_empty() {
                    None
                } else {
                    session_id.map(|session_id| {
                        (
                            session_id,
                            self.capture_id.clone().unwrap_or_else(|| id.clone()),
                            *timestamp,
                            std::mem::take(&mut state.assistant_output),
                        )
                    })
                }
            }
            _ => None,
        };
        if let ChatEvent::Turn { status, .. } = &event {
            state.last_turn_status = (status != "started").then(|| status.clone());
        }
        // 연속된 같은 메시지의 스트리밍 델타는 직전 항목에 합쳐, 리플레이 버퍼가
        // 델타 개수만큼 늘어나 오래된 이벤트(첫 메시지)를 밀어내지 않게 한다.
        match (&event, state.replay.back_mut()) {
            (
                ChatEvent::MessageDelta {
                    id, kind, delta, ..
                },
                Some(ChatEvent::MessageDelta {
                    id: last_id,
                    kind: last_kind,
                    delta: last_delta,
                    ..
                }),
            ) if id == last_id && kind == last_kind => {
                last_delta.push_str(delta);
            }
            _ => {
                state.replay.push_back(event.clone());
                while state.replay.len() > MAX_REPLAY_EVENTS {
                    state.replay.pop_front();
                }
            }
        }
        let provider_session_id = state.provider_session_id.clone();
        let subscriber = state
            .subscriber
            .clone()
            .map(|sender| (sender, state.subscriber_generation));
        drop(state);

        self.attention.observe(self, provider_session_id, &event);

        // 에이전트가 사용량 제한 응답을 반환하면 계정 자동전환 트리거로 전달한다.
        if let ChatEvent::Error { message } = &event {
            if is_usage_limit_message(message) {
                if let (Some(accounts), Some(account_id)) = (&self.accounts, &self.account_id) {
                    let _ = accounts.report_agent_usage_limit(account_id);
                }
            }
        }

        if let Some((session_id, turn_id, completed_at, text)) = captured {
            if let Some(app_data_dir) = &self.app_data_dir {
                let origin = if self.unattended {
                    SupplementOrigin::Scheduled
                } else {
                    SupplementOrigin::Chat
                };
                let _ = store::persist_captured_turn(
                    app_data_dir,
                    self.source,
                    &session_id,
                    &turn_id,
                    completed_at,
                    text,
                    origin,
                );
            }
        }

        if let Some((subscriber, generation)) = subscriber {
            if matches!(
                subscriber.try_send(event),
                Err(TrySendError::Full(_)) | Err(TrySendError::Disconnected(_))
            ) {
                if let Ok(mut state) = self.state.lock() {
                    // 전송 실패와 새 attach가 겹칠 수 있으므로 같은 세대일 때만 지운다.
                    if state.subscriber_generation == generation {
                        state.subscriber = None;
                    }
                }
            }
        }
    }
}

fn codex_turn_input(message: &PendingChatMessage) -> Vec<Value> {
    let mut input = Vec::new();
    if !message.text.is_empty() {
        input.push(json!({"type": "text", "text": message.text, "text_elements": []}));
    }
    for attachment in &message.attachments {
        let path = attachment.path.to_string_lossy();
        if attachment.file.kind == ChatInputFileKind::Image {
            input.push(json!({"type": "localImage", "path": path}));
        } else {
            input.push(json!({
                "type": "mention",
                "name": attachment.file.name,
                "path": path,
            }));
        }
    }
    input
}

fn claim_turn(state: &mut RuntimeState) -> String {
    let turn_id = Uuid::new_v4().to_string();
    state.phase = ChatPhase::Running;
    state.turn_count = state.turn_count.saturating_add(1);
    state.active_turn_id = Some(turn_id.clone());
    state.last_turn_status = None;
    state.assistant_output.clear();
    turn_id
}

fn queue_items(state: &RuntimeState) -> Vec<QueuedChatMessage> {
    state
        .queue
        .iter()
        .map(|message| QueuedChatMessage {
            id: message.id.clone(),
            text: message.text.clone(),
            attachments: message
                .attachments
                .iter()
                .map(|attachment| attachment.file.clone())
                .collect(),
        })
        .collect()
}

fn resolve_input_files(
    state: &RuntimeState,
    attachment_ids: &[String],
) -> Result<Vec<StoredChatInputFile>, CoreError> {
    let mut seen = HashSet::new();
    let mut total_bytes = 0usize;
    let mut attachments = Vec::with_capacity(attachment_ids.len());
    for attachment_id in attachment_ids {
        if !seen.insert(attachment_id) {
            return Err(CoreError::InvalidInput(
                "같은 첨부 파일을 중복해서 보낼 수 없습니다".to_owned(),
            ));
        }
        let attachment =
            state.uploads.get(attachment_id).cloned().ok_or_else(|| {
                CoreError::NotFound("전송할 첨부 파일을 찾을 수 없습니다".to_owned())
            })?;
        total_bytes = total_bytes.saturating_add(attachment.file.size_bytes);
        attachments.push(attachment);
    }
    if total_bytes > MAX_CHAT_INPUT_TOTAL_BYTES {
        return Err(CoreError::TooLarge(MAX_CHAT_INPUT_TOTAL_BYTES as u64));
    }
    Ok(attachments)
}

fn mark_input_files_used(state: &mut RuntimeState, attachment_ids: &[String]) {
    for attachment_id in attachment_ids {
        if let Some(attachment) = state.uploads.get_mut(attachment_id) {
            attachment.used = true;
        }
    }
}

fn validate_input_file_name(name: &str) -> Result<String, CoreError> {
    let name = name.trim();
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.len() > 255
        || name
            .chars()
            .any(|character| character.is_control() || matches!(character, '/' | '\\'))
    {
        return Err(CoreError::InvalidInput(
            "첨부 파일 이름이 올바르지 않습니다".to_owned(),
        ));
    }
    Ok(name.to_owned())
}

fn normalize_media_type(media_type: &str) -> &str {
    let media_type = media_type.trim();
    if !media_type.is_empty()
        && media_type.len() <= 127
        && media_type
            .bytes()
            .all(|byte| byte.is_ascii_graphic() && byte != b';')
        && media_type.contains('/')
    {
        media_type
    } else {
        "application/octet-stream"
    }
}

fn detected_image_media_type(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Some("image/png");
    }
    if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        return Some("image/jpeg");
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Some("image/gif");
    }
    if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    None
}

fn append_captured_output(output: &mut String, delta: &str) {
    if output.len() >= MAX_CAPTURED_OUTPUT_BYTES {
        return;
    }
    let remaining = MAX_CAPTURED_OUTPUT_BYTES - output.len();
    if delta.len() <= remaining {
        output.push_str(delta);
        return;
    }
    let mut end = remaining;
    while !delta.is_char_boundary(end) {
        end -= 1;
    }
    output.push_str(&delta[..end]);
}

fn start_codex_app_server(runtime: &Arc<ChatRuntime>) -> Result<(), CoreError> {
    let mut command = Command::new(&runtime.executable);
    command
        .args(["app-server", "--stdio"])
        .current_dir(&runtime.cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    configure_headless_command(&mut command);
    let mut child = command.spawn().map_err(|error| {
        CoreError::Runtime(format!("Codex app-server를 시작하지 못했습니다: {error}"))
    })?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| CoreError::Runtime("Codex stdin을 열지 못했습니다".to_owned()))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| CoreError::Runtime("Codex stdout을 열지 못했습니다".to_owned()))?;
    let stderr = child.stderr.take();
    let setup_runtime = Arc::clone(runtime);
    let (setup_sender, setup_receiver) = mpsc::sync_channel(1);
    let setup_thread = thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let setup = (|| {
            write_json_line(
                &mut stdin,
                &json!({
                    "id": 1,
                    "method": "initialize",
                    "params": {
                        "clientInfo": {"name": "agent-manager", "title": "Agent Manager", "version": env!("CARGO_PKG_VERSION")},
                        "capabilities": {"experimentalApi": true}
                    }
                }),
            )?;
            read_rpc_result(&mut reader, 1)?;
            write_json_line(&mut stdin, &json!({"method": "initialized"}))?;

            let sandbox = match setup_runtime.mode {
                ChatMode::Plan => "read-only",
                ChatMode::Workspace => "workspace-write",
                ChatMode::FullAccess => "danger-full-access",
            };
            let workspace_roots = if setup_runtime.profile == ChatProfile::Aia {
                aia_workspace_roots(&setup_runtime)
            } else {
                vec![setup_runtime.cwd.clone()]
            };
            let (approval_policy, approvals_reviewer) = codex_approval_settings(&setup_runtime);
            let mut params = json!({
                "cwd": setup_runtime.cwd,
                "approvalPolicy": approval_policy,
                "approvalsReviewer": approvals_reviewer,
                "sandbox": sandbox,
                "runtimeWorkspaceRoots": &workspace_roots,
                "ephemeral": codex_session_is_ephemeral(setup_runtime.profile),
            });
            if setup_runtime.profile == ChatProfile::Aia {
                let mcp_url = setup_runtime.system_mcp_url.as_ref().ok_or_else(|| {
                    CoreError::Runtime("AIA 시스템 MCP 주소가 없습니다".to_owned())
                })?;
                params["developerInstructions"] =
                    Value::String(AIA_DEVELOPER_INSTRUCTIONS.to_owned());
                params["serviceName"] = Value::String("aia".to_owned());
                params["config"] = json!({
                    "mcp_servers": {
                        "aia_system": {
                            "url": mcp_url,
                            "default_tools_approval_mode": "writes",
                            "startup_timeout_sec": 10,
                            "tool_timeout_sec": 120
                        }
                    },
                    "sandbox_workspace_write": {
                        "writable_roots": &workspace_roots,
                        "network_access": false
                    }
                });
            }
            if let Some(model) = &setup_runtime.model {
                params["model"] = Value::String(model.clone());
            }
            let (method, params) = codex_thread_request(&setup_runtime, params)?;
            write_json_line(
                &mut stdin,
                &json!({"id": 2, "method": method, "params": params}),
            )?;
            let result = read_rpc_result(&mut reader, 2).map_err(|error| {
                if setup_runtime.resuming {
                    CoreError::ResumeFailed(format!("Codex 세션을 재개하지 못했습니다: {error}"))
                } else {
                    error
                }
            })?;
            let thread_id = result
                .pointer("/thread/id")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .or_else(|| {
                    setup_runtime
                        .state
                        .lock()
                        .ok()
                        .and_then(|state| state.provider_session_id.clone())
                })
                .ok_or_else(|| {
                    CoreError::Runtime("Codex가 스레드 ID를 반환하지 않았습니다".to_owned())
                })?;
            Ok((stdin, reader, stderr, thread_id))
        })();
        let _ = setup_sender.send(setup);
    });
    let setup = match setup_receiver.recv_timeout(CODEX_STARTUP_TIMEOUT) {
        Ok(setup) => setup,
        Err(mpsc::RecvTimeoutError::Timeout) => {
            let _ = child.kill();
            let _ = child.wait();
            let _ = setup_thread.join();
            return Err(CoreError::Runtime(format!(
                "Codex app-server 초기화가 {}초를 초과했습니다. 작업 경로 접근 권한을 확인하세요",
                CODEX_STARTUP_TIMEOUT.as_secs()
            )));
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => Err(CoreError::Runtime(
            "Codex app-server 초기화 작업이 예기치 않게 종료되었습니다".to_owned(),
        )),
    };
    let _ = setup_thread.join();
    let (stdin, reader, stderr, thread_id) = match setup {
        Ok(setup) => setup,
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
    };
    runtime.update_provider_session_id(&thread_id);

    let child_pid = child.id();
    *lock(&runtime.stdin)? = Some(stdin);
    *lock(&runtime.child)? = Some(child);
    spawn_codex_reader(Arc::clone(runtime), reader);
    if let Some(stderr) = stderr {
        spawn_stderr_reader(Arc::clone(runtime), stderr, "Codex");
    }
    spawn_child_monitor(Arc::clone(runtime), true, child_pid);
    Ok(())
}

fn codex_thread_request(
    runtime: &ChatRuntime,
    mut params: Value,
) -> Result<(&'static str, Value), CoreError> {
    if !runtime.resuming {
        return Ok(("thread/start", params));
    }
    let thread_id = runtime
        .state
        .lock()
        .ok()
        .and_then(|state| state.provider_session_id.clone())
        .ok_or_else(|| CoreError::InvalidInput("재개할 Codex 세션 ID가 없습니다".to_owned()))?;
    params["threadId"] = Value::String(thread_id);
    // 과거 턴은 Agent Manager의 세션 상세가 JSONL에서 필요할 때 읽는다.
    // app-server 재개 응답에서는 제외해 대형 세션의 초기 RPC 줄·메모리 사용을 제한한다.
    params["excludeTurns"] = Value::Bool(true);
    Ok(("thread/resume", params))
}

fn codex_approval_settings(runtime: &ChatRuntime) -> (&'static str, &'static str) {
    match runtime.approval_mode {
        ChatApprovalMode::AutoReview => ("on-request", "auto_review"),
        ChatApprovalMode::Manual if !runtime.unattended => ("on-request", "user"),
        ChatApprovalMode::Manual | ChatApprovalMode::Never => ("never", "user"),
    }
}

fn codex_session_is_ephemeral(profile: ChatProfile) -> bool {
    profile == ChatProfile::Aia
}

fn automatic_approval_decision(runtime: &ChatRuntime) -> Option<ChatApprovalDecision> {
    if runtime.approval_mode == ChatApprovalMode::Never {
        return Some(if runtime.mode == ChatMode::FullAccess {
            ChatApprovalDecision::AcceptForSession
        } else {
            ChatApprovalDecision::Decline
        });
    }
    runtime.unattended.then_some(ChatApprovalDecision::Decline)
}

fn start_claude_stream_cli(runtime: &Arc<ChatRuntime>) -> Result<(), CoreError> {
    let resume = {
        let state = lock(&runtime.state)?;
        runtime.resuming || state.turn_count > 0
    };
    let args = claude_stream_cli_args(runtime, resume);
    let mut command = Command::new(&runtime.executable);
    command
        .args(args)
        .current_dir(&runtime.cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    configure_headless_command(&mut command);
    let mut child = command.spawn().map_err(|error| {
        CoreError::Runtime(format!(
            "Claude 장기 실행 채팅을 시작하지 못했습니다: {error}"
        ))
    })?;
    let setup = (|| {
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| CoreError::Runtime("Claude stdin을 열지 못했습니다".to_owned()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| CoreError::Runtime("Claude stdout을 열지 못했습니다".to_owned()))?;
        Ok((stdin, stdout, child.stderr.take()))
    })();
    let (stdin, stdout, stderr) = match setup {
        Ok(setup) => setup,
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
    };
    let child_pid = child.id();
    *lock(&runtime.stdin)? = Some(stdin);
    *lock(&runtime.child)? = Some(child);
    spawn_stream_reader(Arc::clone(runtime), stdout);
    if let Some(stderr) = stderr {
        spawn_stderr_reader(Arc::clone(runtime), stderr, "Claude");
    }
    spawn_child_monitor(Arc::clone(runtime), true, child_pid);
    Ok(())
}

fn spawn_codex_reader(
    runtime: Arc<ChatRuntime>,
    mut reader: BufReader<impl std::io::Read + Send + 'static>,
) {
    thread::spawn(move || {
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) => break,
                Ok(_) if line.len() <= MAX_JSON_LINE_BYTES => {
                    if let Ok(value) = serde_json::from_str::<Value>(&line) {
                        handle_codex_message(&runtime, value);
                    }
                }
                Ok(_) => runtime.emit(ChatEvent::Error {
                    message: "Codex 이벤트 한 줄이 허용 크기를 초과했습니다".to_owned(),
                }),
                Err(error) => {
                    runtime.emit(ChatEvent::Error {
                        message: format!("Codex 이벤트를 읽지 못했습니다: {error}"),
                    });
                    break;
                }
            }
        }
    });
}

fn handle_codex_message(runtime: &Arc<ChatRuntime>, value: Value) {
    if let Some(error) = value.get("error") {
        runtime.emit(ChatEvent::Error {
            message: json_text(error),
        });
        return;
    }
    if value.get("id").is_some() && value.get("method").is_none() {
        if let Some(turn_id) = value.pointer("/result/turn/id").and_then(Value::as_str) {
            if let Ok(mut state) = runtime.state.lock() {
                state.current_turn_id = Some(turn_id.to_owned());
            }
        }
        return;
    }
    let Some(method) = value.get("method").and_then(Value::as_str) else {
        return;
    };
    let params = value.get("params").cloned().unwrap_or(Value::Null);
    if value.get("id").is_some() {
        handle_codex_request(runtime, method, value["id"].clone(), params);
        return;
    }
    match method {
        "item/agentMessage/delta" => emit_delta(runtime, &params, "assistant", "message"),
        "item/reasoning/summaryTextDelta" => emit_delta(runtime, &params, "assistant", "reasoning"),
        "item/commandExecution/outputDelta" | "item/fileChange/outputDelta" => {
            runtime.emit(ChatEvent::Tool {
                id: value_string(&params, "itemId", "tool"),
                name: if method.contains("commandExecution") {
                    "명령 실행".to_owned()
                } else {
                    "파일 변경".to_owned()
                },
                status: "running".to_owned(),
                detail: None,
                output: params
                    .get("delta")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                append: true,
            });
        }
        "item/started" | "item/completed" => {
            if let Some(item) = params.get("item") {
                emit_codex_item(runtime, item, method == "item/completed");
            }
        }
        "turn/completed" => {
            let status = params
                .pointer("/turn/status")
                .and_then(Value::as_str)
                .unwrap_or("completed")
                .to_owned();
            // 중단으로 턴이 끝났다면 응답을 기다리는 승인 요청이 남아 있을 수 있다.
            runtime.cancel_pending_approvals();
            runtime.set_phase(ChatPhase::Ready);
            runtime.emit_turn(status);
            runtime.drain_queue();
        }
        "error" => runtime.emit(ChatEvent::Error {
            message: params
                .get("message")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .unwrap_or_else(|| json_text(&params)),
        }),
        _ => {}
    }
}

fn handle_codex_request(runtime: &Arc<ChatRuntime>, method: &str, rpc_id: Value, params: Value) {
    let (kind, title, detail, pending, options) = match method {
        "item/commandExecution/requestApproval" => (
            "command",
            "명령 실행 승인",
            params
                .get("command")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .or_else(|| {
                    params
                        .get("reason")
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                }),
            PendingApproval::Codex {
                rpc_id: rpc_id.clone(),
            },
            vec![
                ChatApprovalDecision::Accept,
                ChatApprovalDecision::AcceptForSession,
                ChatApprovalDecision::Decline,
                ChatApprovalDecision::Cancel,
            ],
        ),
        "item/fileChange/requestApproval" => (
            "fileChange",
            "파일 변경 승인",
            params
                .get("reason")
                .and_then(Value::as_str)
                .map(str::to_owned),
            PendingApproval::Codex {
                rpc_id: rpc_id.clone(),
            },
            vec![
                ChatApprovalDecision::Accept,
                ChatApprovalDecision::AcceptForSession,
                ChatApprovalDecision::Decline,
                ChatApprovalDecision::Cancel,
            ],
        ),
        "item/permissions/requestApproval" => (
            "permissions",
            "추가 권한 승인",
            Some(json_text(&params)),
            PendingApproval::Codex {
                rpc_id: rpc_id.clone(),
            },
            vec![
                ChatApprovalDecision::Accept,
                ChatApprovalDecision::AcceptForSession,
                ChatApprovalDecision::Decline,
                ChatApprovalDecision::Cancel,
            ],
        ),
        "mcpServer/elicitation/request" => (
            "mcpElicitation",
            "AIA 시스템 기능 승인",
            Some(json_text(&{
                let mut detail = json!({
                    "server": params.get("serverName"),
                    "message": params.get("message"),
                    "requestedInput": params.get("requestedSchema"),
                });
                if let Some(impact) = system_execute_impact(&params) {
                    detail["impact"] = impact;
                }
                detail
            })),
            PendingApproval::CodexMcpElicitation {
                rpc_id: rpc_id.clone(),
                accepted_content: elicitation_accept_content(&params),
            },
            vec![
                ChatApprovalDecision::Accept,
                ChatApprovalDecision::Decline,
                ChatApprovalDecision::Cancel,
            ],
        ),
        _ => {
            let _ = runtime.write_json(&json!({
                "id": rpc_id,
                "error": {"code": -32601, "message": "Agent Manager에서 지원하지 않는 요청입니다"}
            }));
            return;
        }
    };
    if let Some(decision) = automatic_approval_decision(runtime) {
        let approval_id = format!("approval-{}", Uuid::new_v4());
        runtime.emit(ChatEvent::Approval {
            id: approval_id.clone(),
            kind: kind.to_owned(),
            title: title.to_owned(),
            detail,
            options: vec![decision],
            interactive: false,
        });
        let _ = runtime.write_json(&approval_response(&pending, decision));
        runtime.emit(ChatEvent::ApprovalResolved {
            id: approval_id,
            decision,
        });
        if decision == ChatApprovalDecision::Decline {
            runtime.emit(ChatEvent::Error {
                message: if runtime.unattended {
                    "예약 실행의 선택된 모드 범위를 벗어난 권한 요청을 거절했습니다".to_owned()
                } else {
                    "승인 없이 실행 정책에서 현재 모드 범위를 벗어난 권한 요청을 거절했습니다"
                        .to_owned()
                },
            });
        }
        return;
    }
    let approval_id = format!("approval-{}", Uuid::new_v4());
    if let Ok(mut state) = runtime.state.lock() {
        state.pending_approvals.insert(approval_id.clone(), pending);
        state.phase = ChatPhase::WaitingApproval;
    }
    runtime.emit_state();
    runtime.emit(ChatEvent::Approval {
        id: approval_id,
        kind: kind.to_owned(),
        title: title.to_owned(),
        detail,
        options,
        interactive: true,
    });
}

/// 승인 카드에 표시할 시스템 실행 영향 요약. 승인 요청 메시지에서 작업명과
/// 대상 식별자를 보수적으로 추출해 복구하기 어려운 영향을 함께 표시한다.
fn system_execute_impact(params: &Value) -> Option<Value> {
    let message = params.get("message").and_then(Value::as_str)?;
    const KNOWN: &[(&str, &str)] = &[
        (
            "switch_active_provider_account",
            "실행 중 관리 세션과 외부 독립 실행 CLI 프로세스를 모두 종료한 뒤 활성 계정을 변경합니다. 진행 중 응답, 승인 요청 및 대기 메시지는 복구되지 않을 수 있습니다.",
        ),
        (
            "stop_provider_chats",
            "해당 공급자의 Agent Manager 관리 채팅이 모두 종료됩니다. 진행 중 응답, 승인 요청 및 대기 메시지는 복구되지 않을 수 있습니다.",
        ),
        (
            "terminate_external_provider_processes",
            "Agent Manager 밖에서 독립 실행 중인 해당 공급자 CLI 프로세스(터미널·IDE 확장 등)가 종료됩니다. 해당 프로세스에서 진행 중이던 작업은 복구되지 않을 수 있습니다.",
        ),
        (
            "stop_chat",
            "선택한 채팅이 종료됩니다. 진행 중 응답, 승인 요청 및 대기 메시지는 복구되지 않을 수 있습니다.",
        ),
        (
            "set_active_provider_account",
            "활성 인증 계정이 변경됩니다. 실행 중 관리 런타임이 있으면 거부됩니다.",
        ),
        (
            "register_system_workflow",
            "AIA가 이후 별도 승인 하에 실행할 수 있는 시스템 워크플로가 등록됩니다.",
        ),
        (
            "execute_system_workflow",
            "등록된 시스템 워크플로의 단계가 순차 실행되며 변경 작업이 포함될 수 있습니다.",
        ),
        (
            "delete_system_workflow",
            "등록된 시스템 워크플로와 실행 권한이 제거됩니다.",
        ),
        (
            "start_chat",
            "새 공급자 채팅이 시작되고 첫 메시지가 전달됩니다.",
        ),
        (
            "send_chat_message",
            "기존 채팅에 새 턴 또는 대기열 메시지가 전달됩니다.",
        ),
    ];
    let (operation, warning) = KNOWN.iter().find(|(op, _)| message.contains(op))?;
    let mut warnings = vec![(*warning).to_owned()];
    let mut targets = serde_json::Map::new();
    if let Some(arguments) = embedded_json_object(message) {
        for key in [
            "accountId",
            "provider",
            "chatId",
            "workflowId",
            "cwd",
            "source",
            "mode",
            "approvalMode",
            "stopRunningChats",
        ] {
            if let Some(value) = arguments
                .pointer(&format!("/arguments/{key}"))
                .or_else(|| arguments.pointer(&format!("/arguments/request/{key}")))
                .or_else(|| arguments.pointer(&format!("/arguments/request/chat/{key}")))
                .or_else(|| arguments.pointer(&format!("/{key}")))
                .or_else(|| arguments.pointer(&format!("/request/{key}")))
                .or_else(|| arguments.pointer(&format!("/request/chat/{key}")))
            {
                targets.insert((*key).to_owned(), value.clone());
            }
        }
    }
    if *operation == "start_chat" {
        if message.contains("fullAccess") {
            warnings.push("전체 접근(fullAccess) 권한으로 실행됩니다.".to_owned());
        }
        if message.contains("never") {
            warnings.push("승인 없이(approvalMode: never) 실행될 수 있습니다.".to_owned());
        }
    }
    Some(json!({
        "operation": operation,
        "targets": targets,
        "warnings": warnings,
    }))
}

/// 메시지에 포함된 첫 JSON 객체를 보수적으로 파싱한다. 실패해도 승인 흐름은 계속한다.
fn embedded_json_object(message: &str) -> Option<Value> {
    let start = message.find('{')?;
    let end = message.rfind('}')?;
    if end <= start {
        return None;
    }
    serde_json::from_str(&message[start..=end]).ok()
}

fn elicitation_accept_content(params: &Value) -> Value {
    let schema = params.get("requestedSchema").unwrap_or(&Value::Null);
    let properties = schema
        .get("properties")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let required = schema
        .get("required")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut content = serde_json::Map::new();
    for name in required.iter().filter_map(Value::as_str) {
        let property = properties.get(name).unwrap_or(&Value::Null);
        let value = property
            .get("const")
            .cloned()
            .or_else(|| property.get("default").cloned())
            .or_else(|| property.get("enum")?.as_array()?.first().cloned())
            .unwrap_or_else(|| match property.get("type").and_then(Value::as_str) {
                Some("boolean") => Value::Bool(true),
                Some("number" | "integer") => json!(1),
                Some("array") => json!([]),
                Some("object") => json!({}),
                _ => Value::String("승인".to_owned()),
            });
        content.insert(name.to_owned(), value);
    }
    Value::Object(content)
}

fn emit_codex_item(runtime: &Arc<ChatRuntime>, item: &Value, completed: bool) {
    let item_type = item.get("type").and_then(Value::as_str).unwrap_or("tool");
    let id = value_string(item, "id", "item");
    match item_type {
        "commandExecution" => runtime.emit(ChatEvent::Tool {
            id,
            name: "명령 실행".to_owned(),
            status: item
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or(if completed { "completed" } else { "running" })
                .to_owned(),
            detail: item
                .get("command")
                .and_then(Value::as_str)
                .map(str::to_owned),
            output: item
                .get("aggregatedOutput")
                .and_then(Value::as_str)
                .map(str::to_owned),
            append: false,
        }),
        "fileChange" => runtime.emit(ChatEvent::Tool {
            id,
            name: "파일 변경".to_owned(),
            status: item
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or(if completed { "completed" } else { "running" })
                .to_owned(),
            detail: item.get("changes").map(json_text),
            output: None,
            append: false,
        }),
        "mcpToolCall" | "dynamicToolCall" | "collabAgentToolCall" | "webSearch" => {
            runtime.emit(ChatEvent::Tool {
                id,
                name: item
                    .get("tool")
                    .or_else(|| item.get("query"))
                    .and_then(Value::as_str)
                    .unwrap_or(item_type)
                    .to_owned(),
                status: item
                    .get("status")
                    .and_then(Value::as_str)
                    .unwrap_or(if completed { "completed" } else { "running" })
                    .to_owned(),
                detail: item.get("arguments").map(json_text),
                output: item.get("result").map(json_text),
                append: false,
            });
        }
        _ => {}
    }
}

fn emit_delta(runtime: &Arc<ChatRuntime>, params: &Value, role: &str, kind: &str) {
    if let Some(delta) = params.get("delta").and_then(Value::as_str) {
        runtime.emit(ChatEvent::MessageDelta {
            id: value_string(params, "itemId", kind),
            role: role.to_owned(),
            kind: kind.to_owned(),
            delta: delta.to_owned(),
        });
    }
}

fn spawn_stream_cli(
    runtime: &Arc<ChatRuntime>,
    message: &PendingChatMessage,
) -> Result<(), CoreError> {
    let provider_session_id = lock(&runtime.state)?.provider_session_id.clone();
    let prompt = prompt_with_attachment_paths(message, true);
    let args = antigravity_stream_cli_args(runtime, &prompt, provider_session_id.as_deref());
    let mut command = Command::new(&runtime.executable);
    command
        .args(args)
        .current_dir(&runtime.cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    configure_headless_command(&mut command);
    let mut child = command.spawn().map_err(|error| {
        CoreError::Runtime(format!("구조화 CLI 채팅을 시작하지 못했습니다: {error}"))
    })?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| CoreError::Runtime("CLI stdout을 열지 못했습니다".to_owned()))?;
    let stderr = child.stderr.take();
    let child_pid = child.id();
    *lock(&runtime.child)? = Some(child);

    spawn_stream_reader(Arc::clone(runtime), stdout);
    if let Some(stderr) = stderr {
        spawn_stderr_reader(Arc::clone(runtime), stderr, runtime.source.as_str());
    }
    spawn_child_monitor(Arc::clone(runtime), false, child_pid);
    Ok(())
}

fn spawn_stream_reader(runtime: Arc<ChatRuntime>, stdout: impl std::io::Read + Send + 'static) {
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            match line {
                Ok(line) if line.len() <= MAX_JSON_LINE_BYTES => {
                    if let Ok(value) = serde_json::from_str::<Value>(&line) {
                        handle_stream_cli_message(&runtime, value);
                    } else if !line.trim().is_empty() {
                        runtime.emit(ChatEvent::MessageDelta {
                            id: "assistant-output".to_owned(),
                            role: "assistant".to_owned(),
                            kind: "message".to_owned(),
                            delta: format!("{line}\n"),
                        });
                    }
                }
                Ok(_) => runtime.emit(ChatEvent::Error {
                    message: "CLI 이벤트 한 줄이 허용 크기를 초과했습니다".to_owned(),
                }),
                Err(error) => {
                    runtime.emit(ChatEvent::Error {
                        message: format!("CLI 이벤트를 읽지 못했습니다: {error}"),
                    });
                    break;
                }
            }
        }
    });
}

fn claude_stream_cli_args(runtime: &ChatRuntime, resume: bool) -> Vec<String> {
    let mut args = vec![
        "--print".to_owned(),
        "--verbose".to_owned(),
        "--input-format".to_owned(),
        "stream-json".to_owned(),
        "--output-format".to_owned(),
        "stream-json".to_owned(),
        "--include-partial-messages".to_owned(),
        "--permission-mode".to_owned(),
        match runtime.mode {
            ChatMode::Plan => "plan".to_owned(),
            ChatMode::Workspace => "acceptEdits".to_owned(),
            ChatMode::FullAccess => "bypassPermissions".to_owned(),
        },
    ];
    if !runtime.unattended && runtime.approval_mode != ChatApprovalMode::Never {
        args.extend(["--permission-prompt-tool".to_owned(), "stdio".to_owned()]);
    }
    if let Some(model) = &runtime.model {
        args.extend(["--model".to_owned(), model.clone()]);
    }
    if let Some(effort) = runtime.reasoning_effort {
        args.extend(["--effort".to_owned(), effort.as_str().to_owned()]);
    }
    args.extend(dynamic_setting_args(
        runtime.source,
        &runtime.dynamic_settings,
    ));
    if runtime.profile == ChatProfile::Aia {
        // AIA는 aia_system MCP로만 시스템을 조작한다. `--strict-mcp-config`로 사용자의
        // 다른 MCP 설정이 섞이지 않게 막고, 값이 여러 개인 `--mcp-config` 뒤에는 반드시
        // 다른 플래그가 오도록 배치해 JSON이 통째로 삼켜지지 않게 한다.
        if let Some(url) = &runtime.system_mcp_url {
            args.extend([
                "--mcp-config".to_owned(),
                aia_mcp_config_json(url),
                "--strict-mcp-config".to_owned(),
            ]);
        }
        args.extend([
            "--append-system-prompt".to_owned(),
            AIA_DEVELOPER_INSTRUCTIONS.to_owned(),
        ]);
        for root in aia_workspace_roots(runtime) {
            args.extend(["--add-dir".to_owned(), root.to_string_lossy().into_owned()]);
        }
    }
    if let Ok(root) = runtime.attachment_root() {
        args.extend(["--add-dir".to_owned(), root.to_string_lossy().into_owned()]);
    }
    if let Ok(state) = runtime.state.lock() {
        if let Some(session_id) = &state.provider_session_id {
            args.extend([
                if resume { "--resume" } else { "--session-id" }.to_owned(),
                session_id.clone(),
            ]);
        }
    }
    args
}

/// Claude CLI가 읽는 MCP 설정. AIA 시스템 인터페이스 하나만 노출한다.
fn aia_mcp_config_json(url: &str) -> String {
    json!({"mcpServers": {"aia_system": {"type": "http", "url": url}}}).to_string()
}

/// 해당 공급자 런타임이 aia_system MCP를 붙일 수 있는지. Antigravity CLI는 실행 단위
/// MCP 설정을 제공하지 않으므로, AIA가 시스템 도구 없이 대화만 하게 된다는 사실을
/// 호출부가 알 수 있어야 한다.
pub fn provider_supports_aia_system_mcp(source: ProviderId) -> bool {
    source.can_run_system_agent()
}

fn claude_user_message(message: &PendingChatMessage) -> Result<Value, CoreError> {
    let mut content = Vec::new();
    let text = prompt_with_attachment_paths(message, false);
    if !text.is_empty() {
        content.push(json!({"type": "text", "text": text}));
    }
    for attachment in message
        .attachments
        .iter()
        .filter(|attachment| attachment.file.kind == ChatInputFileKind::Image)
    {
        let data = base64::engine::general_purpose::STANDARD.encode(fs::read(&attachment.path)?);
        content.push(json!({
            "type": "image",
            "source": {
                "type": "base64",
                "media_type": attachment.file.media_type,
                "data": data,
            }
        }));
    }
    Ok(json!({
        "type": "user",
        "message": {"role": "user", "content": content},
        "parent_tool_use_id": Value::Null,
    }))
}

fn prompt_with_attachment_paths(message: &PendingChatMessage, include_images: bool) -> String {
    let attachments = message
        .attachments
        .iter()
        .filter(|attachment| include_images || attachment.file.kind == ChatInputFileKind::File)
        .map(|attachment| {
            format!(
                "- {}: {}",
                serde_json::to_string(&attachment.file.name)
                    .unwrap_or_else(|_| "\"file\"".to_owned()),
                serde_json::to_string(&attachment.path.to_string_lossy())
                    .unwrap_or_else(|_| "\"\"".to_owned())
            )
        })
        .collect::<Vec<_>>();
    if attachments.is_empty() {
        return message.text.clone();
    }
    let prefix = if message.text.is_empty() {
        String::new()
    } else {
        format!("{}\n\n", message.text)
    };
    format!(
        "{prefix}<attached_files>\n{}\n</attached_files>\n위 파일은 사용자가 이 메시지에 첨부했습니다.",
        attachments.join("\n")
    )
}

fn claude_control_request(request_id: &str, subtype: &str) -> Value {
    json!({
        "type": "control_request",
        "request_id": request_id,
        "request": {"subtype": subtype},
    })
}

fn antigravity_stream_cli_args(
    runtime: &ChatRuntime,
    prompt: &str,
    provider_session_id: Option<&str>,
) -> Vec<String> {
    // Antigravity CLI에는 시스템 프롬프트 플래그가 없다. AIA 프로필의 첫 요청에만
    // 개발자 지침을 붙여 대화 맥락으로 전달한다.
    let prompt = if runtime.profile == ChatProfile::Aia && provider_session_id.is_none() {
        format!("{AIA_DEVELOPER_INSTRUCTIONS}\n\n---\n\n{prompt}")
    } else {
        prompt.to_owned()
    };
    let mut args = vec![
        "--print".to_owned(),
        prompt.clone(),
        "--output-format".to_owned(),
        "stream-json".to_owned(),
        "--mode".to_owned(),
        match runtime.mode {
            ChatMode::Plan => "plan".to_owned(),
            ChatMode::Workspace | ChatMode::FullAccess => "accept-edits".to_owned(),
        },
    ];
    if runtime.mode == ChatMode::FullAccess {
        args.push("--dangerously-skip-permissions".to_owned());
    }
    if let Some(model) = &runtime.model {
        args.extend(["--model".to_owned(), model.clone()]);
    }
    if let Some(effort) = runtime.reasoning_effort {
        args.extend(["--effort".to_owned(), effort.as_str().to_owned()]);
    }
    args.extend(dynamic_setting_args(
        runtime.source,
        &runtime.dynamic_settings,
    ));
    if let Ok(root) = runtime.attachment_root() {
        args.extend(["--add-dir".to_owned(), root.to_string_lossy().into_owned()]);
    }
    if let Some(session_id) = provider_session_id {
        args.extend(["--conversation".to_owned(), session_id.to_owned()]);
    }
    args
}

fn configure_headless_command(command: &mut Command) {
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    #[cfg(not(windows))]
    let _ = command;
}

fn handle_claude_control_request(runtime: &Arc<ChatRuntime>, value: &Value) {
    let request_id = value
        .get("request_id")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let request = value.get("request").unwrap_or(&Value::Null);
    if request_id.is_empty()
        || request.get("subtype").and_then(Value::as_str) != Some("can_use_tool")
    {
        let _ = runtime.write_json(&json!({
            "type": "control_response",
            "response": {
                "subtype": "error",
                "request_id": request_id,
                "error": "Agent Manager에서 지원하지 않는 Claude 제어 요청입니다",
            },
        }));
        runtime.emit(ChatEvent::Error {
            message: "지원하지 않는 Claude 제어 요청을 거절했습니다".to_owned(),
        });
        return;
    }

    let tool_name = request
        .get("tool_name")
        .and_then(Value::as_str)
        .unwrap_or("도구");
    let input = request.get("input").cloned().unwrap_or(Value::Null);
    let permission_suggestions = request
        .get("permission_suggestions")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let title = request
        .get("title")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .unwrap_or_else(|| {
            let action = request
                .get("display_name")
                .and_then(Value::as_str)
                .unwrap_or(tool_name);
            format!("Claude 권한 확인 · {action}")
        });
    let detail = json_text(&json!({
        "tool": tool_name,
        "description": request.get("description"),
        "reason": request.get("decision_reason"),
        "blockedPath": request.get("blocked_path"),
        "input": &input,
    }));
    let pending = PendingApproval::Claude {
        request_id: request_id.to_owned(),
        input,
        permission_suggestions,
    };
    let approval_id = format!("approval-{}", Uuid::new_v4());

    if let Some(decision) = automatic_approval_decision(runtime) {
        runtime.emit(ChatEvent::Approval {
            id: approval_id.clone(),
            kind: "permission".to_owned(),
            title,
            detail: Some(detail),
            options: vec![decision],
            interactive: false,
        });
        let _ = runtime.write_json(&approval_response(&pending, decision));
        runtime.emit(ChatEvent::ApprovalResolved {
            id: approval_id,
            decision,
        });
        if decision == ChatApprovalDecision::Decline {
            runtime.emit(ChatEvent::Error {
                message: if runtime.unattended {
                    "무인 실행 정책에 따라 Claude 권한 요청을 거절했습니다".to_owned()
                } else {
                    "승인 없이 실행 정책에서 현재 모드 범위를 벗어난 Claude 권한 요청을 거절했습니다"
                        .to_owned()
                },
            });
        }
        return;
    }

    if let Ok(mut state) = runtime.state.lock() {
        state.pending_approvals.insert(approval_id.clone(), pending);
        state.phase = ChatPhase::WaitingApproval;
    }
    runtime.emit_state();
    runtime.emit(ChatEvent::Approval {
        id: approval_id,
        kind: "permission".to_owned(),
        title,
        detail: Some(detail),
        options: vec![
            ChatApprovalDecision::Accept,
            ChatApprovalDecision::AcceptForSession,
            ChatApprovalDecision::Decline,
            ChatApprovalDecision::Cancel,
        ],
        interactive: true,
    });
}

fn handle_claude_control_cancel(runtime: &Arc<ChatRuntime>, value: &Value) {
    let request_id = value
        .get("request_id")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if request_id.is_empty() {
        return;
    }
    let removed = runtime.state.lock().ok().and_then(|mut state| {
        let approval_id = state.pending_approvals.iter().find_map(|(id, pending)| {
            matches!(pending, PendingApproval::Claude { request_id: pending_id, .. } if pending_id == request_id)
                .then(|| id.clone())
        })?;
        state.pending_approvals.remove(&approval_id);
        state.phase = if state.pending_approvals.is_empty() {
            ChatPhase::Running
        } else {
            ChatPhase::WaitingApproval
        };
        Some(approval_id)
    });
    if let Some(approval_id) = removed {
        runtime.emit_state();
        runtime.emit(ChatEvent::ApprovalResolved {
            id: approval_id,
            decision: ChatApprovalDecision::Cancel,
        });
    }
}

fn handle_stream_cli_message(runtime: &Arc<ChatRuntime>, value: Value) {
    if let Some(session_id) = value
        .get("session_id")
        .or_else(|| value.get("sessionId"))
        .or_else(|| value.get("conversation_id"))
        .or_else(|| value.get("conversationId"))
        .and_then(Value::as_str)
    {
        runtime.update_provider_session_id(session_id);
    }
    if runtime.source == ProviderId::Antigravity {
        handle_antigravity_stream_message(runtime, &value);
        return;
    }
    match value
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default()
    {
        "control_request" => handle_claude_control_request(runtime, &value),
        "control_cancel_request" => handle_claude_control_cancel(runtime, &value),
        "control_response" => {
            let response = value.get("response").unwrap_or(&Value::Null);
            let request_id = response
                .get("request_id")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if response.get("subtype").and_then(Value::as_str) == Some("error") {
                if request_id.starts_with("interrupt-") {
                    if let Ok(mut state) = runtime.state.lock() {
                        state.claude_interrupt_pending = false;
                    }
                }
                runtime.emit(ChatEvent::Error {
                    message: response
                        .get("error")
                        .and_then(Value::as_str)
                        .unwrap_or("Claude 제어 요청이 실패했습니다")
                        .to_owned(),
                });
            }
        }
        "stream_event" => {
            handle_anthropic_stream_event(runtime, value.get("event").unwrap_or(&Value::Null))
        }
        "assistant" => {
            if value.get("error").is_some() {
                if let Some(text) = first_content_text(value.pointer("/message/content")) {
                    runtime.emit(ChatEvent::Error { message: text });
                }
            }
            handle_anthropic_message_content(runtime, value.pointer("/message/content"), false);
        }
        "user" => {
            handle_anthropic_message_content(runtime, value.pointer("/message/content"), true)
        }
        "result" => {
            let denials = value
                .get("permission_denials")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let had_denials = !denials.is_empty();
            for denial in &denials {
                runtime.emit(ChatEvent::Approval {
                    id: format!("denied-{}", Uuid::new_v4()),
                    kind: "permission".to_owned(),
                    title: "CLI 권한 자동 거절".to_owned(),
                    detail: Some(json_text(denial)),
                    options: Vec::new(),
                    interactive: false,
                });
            }
            let failed = value
                .get("is_error")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let interrupted = runtime
                .state
                .lock()
                .map(|mut state| {
                    let interrupted = state.claude_interrupt_pending;
                    state.claude_interrupt_pending = false;
                    interrupted
                })
                .unwrap_or(false);
            runtime.discard_pending_approvals();
            let completed_status = if had_denials {
                "completedWithDenials"
            } else {
                "completed"
            };
            // 사용자 중단은 CLI가 is_error를 함께 보내더라도 실패가 아니다.
            let turn_status = if interrupted {
                "interrupted"
            } else if failed {
                "failed"
            } else {
                completed_status
            };
            finish_anthropic_tools(runtime, turn_status);
            if failed && !interrupted {
                runtime.emit(ChatEvent::Error {
                    message: value
                        .get("result")
                        .and_then(Value::as_str)
                        .unwrap_or("CLI 응답이 실패했습니다")
                        .to_owned(),
                });
            }
            runtime.set_phase(ChatPhase::Ready);
            runtime.emit_turn(turn_status);
            runtime.drain_queue();
        }
        "message" => {
            if let Some(text) = value.get("text").and_then(Value::as_str) {
                runtime.emit(ChatEvent::MessageDelta {
                    id: value_string(&value, "id", "assistant-message"),
                    role: value
                        .get("role")
                        .and_then(Value::as_str)
                        .unwrap_or("assistant")
                        .to_owned(),
                    kind: "message".to_owned(),
                    delta: text.to_owned(),
                });
            }
        }
        _ => {}
    }
}

fn handle_antigravity_stream_message(runtime: &Arc<ChatRuntime>, value: &Value) {
    match value
        .get("event")
        .and_then(Value::as_str)
        .unwrap_or_default()
    {
        "step_update" => {
            let step = value.get("step_update").unwrap_or(&Value::Null);
            if step.get("step_type").and_then(Value::as_str) != Some("tool") {
                return;
            }
            let index = step.get("step_index").and_then(Value::as_u64).unwrap_or(0);
            let turn = runtime
                .state
                .lock()
                .map(|state| state.turn_count)
                .unwrap_or(0);
            let tool_info = step.get("tool_info").unwrap_or(&Value::Null);
            let status = match step
                .get("state")
                .and_then(Value::as_str)
                .unwrap_or_default()
            {
                "DONE" => "completed",
                "ERROR" => "failed",
                _ => "running",
            };
            let output = tool_info
                .get("output")
                .or_else(|| tool_info.get("result"))
                .and_then(content_text)
                .or_else(|| {
                    tool_info
                        .pointer("/error/message")
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                });
            runtime.emit(ChatEvent::Tool {
                id: format!("antigravity-tool-{turn}-{index}"),
                name: step
                    .get("tool_name")
                    .or_else(|| tool_info.get("name"))
                    .and_then(Value::as_str)
                    .unwrap_or("도구")
                    .to_owned(),
                status: status.to_owned(),
                detail: meaningful_json(tool_info.get("parameters")),
                output,
                append: false,
            });
        }
        "result" => {
            let result = value.get("result").unwrap_or(&Value::Null);
            let succeeded = result.get("status").and_then(Value::as_str) == Some("SUCCESS");
            let response = result
                .get("response")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|text| !text.is_empty());
            if succeeded {
                if let Some(response) = response {
                    let turn = runtime
                        .state
                        .lock()
                        .map(|state| state.turn_count)
                        .unwrap_or(0);
                    runtime.emit(ChatEvent::MessageDelta {
                        id: format!("antigravity-response-{turn}"),
                        role: "assistant".to_owned(),
                        kind: "message".to_owned(),
                        delta: response.to_owned(),
                    });
                }
            } else {
                runtime.emit(ChatEvent::Error {
                    message: result
                        .get("error")
                        .map(json_text)
                        .or_else(|| response.map(str::to_owned))
                        .unwrap_or_else(|| "Antigravity 응답이 실패했습니다".to_owned()),
                });
            }
            runtime.set_phase(ChatPhase::Ready);
            runtime.emit_turn(if succeeded { "completed" } else { "failed" });
            runtime.drain_queue();
        }
        "error" => runtime.emit(ChatEvent::Error {
            message: value
                .get("message")
                .map(json_text)
                .unwrap_or_else(|| "Antigravity CLI 오류가 발생했습니다".to_owned()),
        }),
        _ => {}
    }
}

fn handle_anthropic_stream_event(runtime: &Arc<ChatRuntime>, event: &Value) {
    match event
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default()
    {
        "content_block_delta" => {
            let delta = event.get("delta").unwrap_or(&Value::Null);
            if let Some(text) = delta.get("text").and_then(Value::as_str) {
                runtime.emit(ChatEvent::MessageDelta {
                    id: value_string(event, "message_id", "assistant-message"),
                    role: "assistant".to_owned(),
                    kind: "message".to_owned(),
                    delta: text.to_owned(),
                });
            } else if let Some(json_delta) = delta.get("partial_json").and_then(Value::as_str) {
                let index = event.get("index").and_then(Value::as_u64).unwrap_or(0);
                let tool = runtime.state.lock().ok().and_then(|mut state| {
                    let tool = state.provider_tool_blocks.get_mut(&index)?;
                    tool.input.push_str(json_delta);
                    Some((tool.id.clone(), tool.name.clone()))
                });
                if let Some((id, name)) = tool {
                    runtime.emit(ChatEvent::Tool {
                        id,
                        name,
                        status: "running".to_owned(),
                        detail: Some(json_delta.to_owned()),
                        output: None,
                        append: true,
                    });
                }
            }
        }
        "content_block_start" => {
            let block = event.get("content_block").unwrap_or(&Value::Null);
            if block.get("type").and_then(Value::as_str) == Some("tool_use") {
                let index = event.get("index").and_then(Value::as_u64).unwrap_or(0);
                let id = value_string(block, "id", &format!("tool-{index}"));
                let name = block
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("도구")
                    .to_owned();
                let initial_input = meaningful_json(block.get("input"));
                if let Ok(mut state) = runtime.state.lock() {
                    state.provider_tool_blocks.insert(
                        index,
                        ProviderToolBlock {
                            id: id.clone(),
                            name: name.clone(),
                            input: initial_input.clone().unwrap_or_default(),
                        },
                    );
                }
                runtime.emit(ChatEvent::Tool {
                    id,
                    name,
                    status: "running".to_owned(),
                    detail: initial_input,
                    output: None,
                    append: false,
                });
            }
        }
        "content_block_stop" => {
            let index = event.get("index").and_then(Value::as_u64).unwrap_or(0);
            let tool = runtime
                .state
                .lock()
                .ok()
                .and_then(|state| state.provider_tool_blocks.get(&index).cloned());
            if let Some(tool) = tool {
                runtime.emit(ChatEvent::Tool {
                    id: tool.id,
                    name: tool.name,
                    status: "running".to_owned(),
                    detail: pretty_json_text(&tool.input),
                    output: None,
                    append: false,
                });
            }
        }
        _ => {}
    }
}

fn handle_anthropic_message_content(
    runtime: &Arc<ChatRuntime>,
    content: Option<&Value>,
    tool_results: bool,
) {
    let Some(blocks) = content.and_then(Value::as_array) else {
        return;
    };
    for block in blocks {
        let block_type = block.get("type").and_then(Value::as_str);
        if !tool_results && block_type == Some("tool_use") {
            let id = value_string(block, "id", "tool");
            let name = block
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("도구")
                .to_owned();
            runtime.emit(ChatEvent::Tool {
                id,
                name,
                status: "running".to_owned(),
                detail: meaningful_json(block.get("input")),
                output: None,
                append: false,
            });
        } else if tool_results && block_type == Some("tool_result") {
            let id = value_string(block, "tool_use_id", "tool-result");
            let name = runtime
                .state
                .lock()
                .ok()
                .and_then(|mut state| {
                    let index = state
                        .provider_tool_blocks
                        .iter()
                        .find_map(|(index, tool)| (tool.id == id).then_some(*index))?;
                    state
                        .provider_tool_blocks
                        .remove(&index)
                        .map(|tool| tool.name)
                })
                .unwrap_or_else(|| "도구".to_owned());
            runtime.emit(ChatEvent::Tool {
                id,
                name,
                status: if block
                    .get("is_error")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                {
                    "failed"
                } else {
                    "completed"
                }
                .to_owned(),
                detail: None,
                output: block.get("content").and_then(content_text),
                append: false,
            });
        }
    }
}

fn finish_anthropic_tools(runtime: &Arc<ChatRuntime>, status: &str) {
    let tools = runtime
        .state
        .lock()
        .map(|mut state| {
            state
                .provider_tool_blocks
                .drain()
                .map(|(_, tool)| tool)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    for tool in tools {
        runtime.emit(ChatEvent::Tool {
            id: tool.id,
            name: tool.name,
            status: status.to_owned(),
            detail: pretty_json_text(&tool.input),
            output: None,
            append: false,
        });
    }
}

fn spawn_stderr_reader(
    runtime: Arc<ChatRuntime>,
    stderr: impl std::io::Read + Send + 'static,
    provider: &str,
) {
    let provider = provider.to_owned();
    thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            let line = strip_ansi(&line);
            if !line.trim().is_empty() {
                runtime.emit(ChatEvent::Tool {
                    id: format!("{}-stderr", runtime.chat_id),
                    name: format!("{provider} 로그"),
                    status: "log".to_owned(),
                    detail: None,
                    output: Some(format!("{line}\n")),
                    append: true,
                });
            }
        }
    });
}

/// 종료 확인 없이 SIGKILL만 전송한다. 이미 사라진 프로세스(ESRCH)는 무시한다.
#[cfg(unix)]
fn send_sigkill(pid: u32) {
    unsafe {
        libc::kill(pid as libc::pid_t, libc::SIGKILL);
    }
}

#[cfg(not(unix))]
fn send_sigkill(_pid: u32) {}

/// PID로 SIGKILL을 보낸 뒤 최대 2초 동안 종료·회수를 확인한다.
/// 이미 종료되었거나 다른 경로로 회수된 프로세스는 성공으로 간주한다.
#[cfg(unix)]
fn ensure_pid_terminated(pid: u32) -> Result<(), String> {
    let pid = pid as libc::pid_t;
    // 이미 없는 프로세스(ESRCH)는 성공 경로이므로 전송 결과는 확인하지 않는다.
    unsafe {
        libc::kill(pid, libc::SIGKILL);
    }
    for _ in 0..40 {
        let mut status: libc::c_int = 0;
        let reaped = unsafe { libc::waitpid(pid, &mut status, libc::WNOHANG) };
        // 회수를 마쳤거나(ECHILD 포함) 이미 다른 경로에서 회수된 상태다.
        if reaped == pid || reaped == -1 {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(50));
    }
    Err(format!(
        "SIGKILL 이후에도 프로세스 {pid}이(가) 종료되지 않았습니다"
    ))
}

#[cfg(not(unix))]
fn ensure_pid_terminated(_pid: u32) -> Result<(), String> {
    Err("이 플랫폼에서는 PID 기반 강제 종료를 지원하지 않습니다".to_owned())
}

fn spawn_child_monitor(runtime: Arc<ChatRuntime>, persistent: bool, child_pid: u32) {
    thread::spawn(move || loop {
        let status = {
            let mut child = match runtime.child.lock() {
                Ok(child) => child,
                Err(_) => return,
            };
            let Some(child) = child.as_mut() else {
                return;
            };
            if child.id() != child_pid {
                // 다음 턴의 프로세스가 슬롯을 차지했으므로 이 모니터는 물러난다.
                return;
            }
            match child.try_wait() {
                Ok(status) => status,
                Err(error) => {
                    runtime.emit(ChatEvent::Error {
                        message: format!("채팅 프로세스 상태를 확인하지 못했습니다: {error}"),
                    });
                    return;
                }
            }
        };
        if let Some(status) = status {
            if let Ok(mut child) = runtime.child.lock() {
                *child = None;
            }
            if let Ok(mut stdin) = runtime.stdin.lock() {
                *stdin = None;
            }
            if persistent {
                runtime.release_account_runtime();
                runtime.discard_pending_approvals();
                let (was_stopped, had_active_turn) = runtime
                    .state
                    .lock()
                    .map(|mut state| {
                        let was_stopped = state.phase == ChatPhase::Stopped;
                        let had_active_turn = state.active_turn_id.is_some();
                        state.claude_interrupt_pending = false;
                        (was_stopped, had_active_turn)
                    })
                    .unwrap_or((false, false));
                if was_stopped {
                    return;
                }
                runtime.set_phase(if status.success() {
                    ChatPhase::Stopped
                } else {
                    ChatPhase::Failed
                });
                if !status.success() {
                    runtime.emit(ChatEvent::Error {
                        message: format!("구조화 채팅 프로세스가 종료되었습니다: {status}"),
                    });
                }
                if runtime.source == ProviderId::Claude && had_active_turn {
                    runtime.emit_turn("failed");
                }
            } else {
                let should_finish = runtime
                    .state
                    .lock()
                    .map(|state| {
                        matches!(state.phase, ChatPhase::Running | ChatPhase::WaitingApproval)
                    })
                    .unwrap_or(false);
                if should_finish {
                    runtime.set_phase(ChatPhase::Ready);
                    runtime.emit_turn(if status.success() {
                        "completed"
                    } else {
                        "failed"
                    });
                    runtime.drain_queue();
                }
            }
            return;
        }
        thread::sleep(Duration::from_millis(150));
    });
}

fn write_json_line(stdin: &mut ChildStdin, value: &Value) -> Result<(), CoreError> {
    serde_json::to_writer(&mut *stdin, value)?;
    stdin.write_all(b"\n")?;
    stdin.flush()?;
    Ok(())
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| i64::try_from(duration.as_millis()).ok())
        .unwrap_or_default()
}

fn read_rpc_result(reader: &mut impl BufRead, expected_id: u64) -> Result<Value, CoreError> {
    let mut line = String::new();
    loop {
        line.clear();
        if reader.read_line(&mut line)? == 0 {
            return Err(CoreError::Runtime(
                "구조화 채팅 프로세스가 초기화 중 종료되었습니다".to_owned(),
            ));
        }
        if line.len() > MAX_JSON_LINE_BYTES {
            return Err(CoreError::TooLarge(MAX_JSON_LINE_BYTES as u64));
        }
        let value: Value = serde_json::from_str(&line)?;
        if value.get("id").and_then(Value::as_u64) != Some(expected_id) {
            continue;
        }
        if let Some(error) = value.get("error") {
            return Err(CoreError::Runtime(json_text(error)));
        }
        return value
            .get("result")
            .cloned()
            .ok_or_else(|| CoreError::Runtime("JSON-RPC 결과가 없습니다".to_owned()));
    }
}

fn resolve_executable(source: ProviderId) -> Result<PathBuf, CoreError> {
    let status = inspect_local_environment()?;
    let path = status
        .providers
        .into_iter()
        .find(|provider| provider.provider == source)
        .and_then(|provider| provider.cli.path)
        .ok_or_else(|| CoreError::NotFound("공급자 CLI가 설치되어 있지 않습니다".to_owned()))?;
    let path = fs::canonicalize(path)?;
    if !path.is_file() {
        return Err(CoreError::InvalidInput(
            "공급자 CLI 경로가 실행 파일이 아닙니다".to_owned(),
        ));
    }
    Ok(path)
}

fn normalize_model(model: Option<String>) -> Result<Option<String>, CoreError> {
    let Some(model) = model else { return Ok(None) };
    let model = model.trim();
    if model.is_empty() {
        return Ok(None);
    }
    if model.len() > 128
        || !model.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':' | b'/')
        })
    {
        return Err(CoreError::InvalidInput(
            "잘못된 모델 식별자입니다".to_owned(),
        ));
    }
    Ok(Some(model.to_owned()))
}

fn first_content_text(value: Option<&Value>) -> Option<String> {
    value?
        .as_array()?
        .iter()
        .find_map(|block| block.get("text").and_then(Value::as_str).map(str::to_owned))
}

fn meaningful_json(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::Null => None,
        Value::Object(object) if object.is_empty() => None,
        Value::Array(items) if items.is_empty() => None,
        Value::String(text) if text.trim().is_empty() => None,
        value => Some(json_text(value)),
    }
}

fn pretty_json_text(text: &str) -> Option<String> {
    let text = text.trim();
    if text.is_empty() {
        return None;
    }
    match serde_json::from_str::<Value>(text) {
        Ok(value) => meaningful_json(Some(&value)),
        Err(_) => Some(text.to_owned()),
    }
}

fn content_text(value: &Value) -> Option<String> {
    if let Some(text) = value.as_str() {
        return (!text.is_empty()).then(|| text.to_owned());
    }
    if let Some(items) = value.as_array() {
        let text = items
            .iter()
            .filter_map(|item| {
                item.get("text")
                    .and_then(Value::as_str)
                    .or_else(|| item.get("content").and_then(Value::as_str))
            })
            .collect::<Vec<_>>()
            .join("\n");
        return (!text.is_empty()).then_some(text);
    }
    meaningful_json(Some(value))
}

fn value_string(value: &Value, key: &str, fallback: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or(fallback)
        .to_owned()
}

fn json_text(value: &Value) -> String {
    if let Some(text) = value.as_str() {
        return text.to_owned();
    }
    serde_json::to_string_pretty(value)
        .unwrap_or_else(|_| "구조화 데이터를 표시할 수 없습니다".to_owned())
}

fn strip_ansi(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut output = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] != 0x1b {
            output.push(bytes[index]);
            index += 1;
            continue;
        }
        index += 1;
        if index >= bytes.len() {
            break;
        }
        if bytes[index] == b'[' {
            index += 1;
            while index < bytes.len() {
                let byte = bytes[index];
                index += 1;
                if (0x40..=0x7e).contains(&byte) {
                    break;
                }
            }
        } else {
            index += 1;
        }
    }
    String::from_utf8_lossy(&output).into_owned()
}

fn lock<T>(mutex: &Mutex<T>) -> Result<MutexGuard<'_, T>, CoreError> {
    mutex
        .lock()
        .map_err(|_| CoreError::Runtime("채팅 상태 잠금이 손상되었습니다".to_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn usage_limit_messages_are_classified_conservatively() {
        assert!(is_usage_limit_message(
            "Claude AI usage limit reached|1755500000"
        ));
        assert!(is_usage_limit_message("You've hit your usage limit."));
        assert!(is_usage_limit_message("5-hour limit reached ∙ resets 3am"));
        assert!(is_usage_limit_message("Rate limit reached for requests"));
        assert!(is_usage_limit_message("HTTP 429: Too Many Requests"));
        assert!(is_usage_limit_message(
            "quota exceeded for this billing cycle"
        ));
        assert!(!is_usage_limit_message("command not found: codex"));
        assert!(!is_usage_limit_message("연결이 종료되었습니다"));
        assert!(!is_usage_limit_message("invalid model requested"));
        assert!(!is_usage_limit_message(""));
    }

    #[test]
    fn resumed_codex_session_in_aia_workspace_restores_aia_profile() {
        let data = tempfile::tempdir().expect("app data");
        let aia_workspace = data.path().join("aia-workspace");
        let standard_workspace = data.path().join("standard-workspace");
        fs::create_dir(&aia_workspace).expect("AIA workspace");
        fs::create_dir(&standard_workspace).expect("standard workspace");
        let mut request = ChatStartRequest {
            source: ProviderId::Codex,
            account_id: None,
            cwd: aia_workspace.to_string_lossy().into_owned(),
            model: None,
            reasoning_effort: None,
            mode: ChatMode::Plan,
            approval_mode: ChatApprovalMode::Manual,
            resume_session_id: Some("aia-session".to_owned()),
            capture_id: None,
            unattended: false,
            profile: ChatProfile::Standard,
            settings: BTreeMap::new(),
            account_transition_id: None,
            startup_cancel: None,
        };

        assert_eq!(
            effective_chat_profile(&request, Some(&data.path().to_path_buf()))
                .expect("restored AIA profile"),
            ChatProfile::Aia
        );

        request.resume_session_id = None;
        assert_eq!(
            effective_chat_profile(&request, Some(&data.path().to_path_buf()))
                .expect("fresh standard profile"),
            ChatProfile::Standard
        );

        request.resume_session_id = Some("standard-session".to_owned());
        request.cwd = standard_workspace.to_string_lossy().into_owned();
        assert_eq!(
            effective_chat_profile(&request, Some(&data.path().to_path_buf()))
                .expect("resumed standard profile"),
            ChatProfile::Standard
        );
    }

    #[test]
    fn aia_always_uses_workspace_mode() {
        assert_eq!(
            effective_chat_mode(ChatProfile::Aia, ChatMode::Plan),
            ChatMode::Workspace
        );
        assert_eq!(
            effective_chat_mode(ChatProfile::Aia, ChatMode::FullAccess),
            ChatMode::Workspace
        );
        assert_eq!(
            effective_chat_mode(ChatProfile::Standard, ChatMode::Plan),
            ChatMode::Plan
        );
    }

    #[test]
    fn aia_workspace_roots_include_all_visible_existing_projects() {
        let root = tempfile::tempdir().expect("temporary root");
        let aia_workspace = root.path().join("aia-workspace");
        let first_project = root.path().join("first-project");
        let second_project = root.path().join("second-project");
        let hidden_project = root.path().join("hidden-project");
        fs::create_dir_all(&aia_workspace).expect("AIA workspace");
        fs::create_dir_all(&first_project).expect("first project");
        fs::create_dir_all(&second_project).expect("second project");
        fs::create_dir_all(&hidden_project).expect("hidden project");

        let sessions = vec![
            session_with_project("first", &first_project, false),
            session_with_project("first-duplicate", &first_project, false),
            session_with_project("second", &second_project, false),
            session_with_project("hidden", &hidden_project, true),
            session_with_project("missing", &root.path().join("missing"), false),
        ];
        let roots = project_workspace_roots(&aia_workspace, &sessions);

        assert_eq!(
            roots,
            vec![
                fs::canonicalize(aia_workspace).expect("canonical AIA workspace"),
                fs::canonicalize(first_project).expect("canonical first project"),
                fs::canonicalize(second_project).expect("canonical second project"),
            ]
        );
        let policy = workspace_write_sandbox_policy(&roots);
        assert_eq!(
            policy.get("type").and_then(Value::as_str),
            Some("workspaceWrite")
        );
        assert_eq!(
            policy
                .get("writableRoots")
                .and_then(Value::as_array)
                .map(Vec::len),
            Some(3)
        );
        assert_eq!(
            policy.get("networkAccess").and_then(Value::as_bool),
            Some(false)
        );
    }

    #[test]
    fn model_identifier_rejects_shell_characters() {
        assert!(normalize_model(Some("gpt-5.6-sol".to_owned())).is_ok());
        assert!(normalize_model(Some("model; rm".to_owned())).is_err());
    }

    #[test]
    fn claude_long_lived_arguments_distinguish_new_and_resumed_sessions() {
        let runtime = fixture_runtime(ProviderId::Claude);
        runtime
            .state
            .lock()
            .expect("runtime state")
            .provider_session_id = Some("abc".to_owned());
        let first = claude_stream_cli_args(&runtime, false);
        let resumed = claude_stream_cli_args(&runtime, true);
        assert!(first.windows(2).any(|args| args == ["--session-id", "abc"]));
        assert!(resumed.windows(2).any(|args| args == ["--resume", "abc"]));
        assert!(first
            .windows(2)
            .any(|args| args == ["--input-format", "stream-json"]));
        assert!(!first.iter().any(|arg| arg == "hello"));
    }

    #[test]
    fn cli_arguments_include_selected_reasoning_effort() {
        let mut claude = fixture_runtime(ProviderId::Claude);
        claude.reasoning_effort = Some(ReasoningEffort::High);
        let claude_args = claude_stream_cli_args(&claude, false);
        assert!(claude_args
            .windows(2)
            .any(|args| args == ["--effort", "high"]));

        let mut antigravity = fixture_runtime(ProviderId::Antigravity);
        antigravity.reasoning_effort = Some(ReasoningEffort::High);
        let antigravity_args = antigravity_stream_cli_args(&antigravity, "hello", None);
        assert!(antigravity_args
            .windows(2)
            .any(|args| args == ["--effort", "high"]));
    }

    #[test]
    fn codex_catalog_preserves_model_specific_reasoning_options() {
        let model = parse_codex_model(&json!({
            "model": "gpt-5.6-sol",
            "displayName": "GPT-5.6-Sol",
            "description": "Latest frontier agentic coding model.",
            "isDefault": true,
            "defaultReasoningEffort": "medium",
            "supportedReasoningEfforts": [
                {"reasoningEffort": "low", "description": "Fast"},
                {"reasoningEffort": "ultra", "description": "Delegation"}
            ]
        }))
        .expect("catalog model");
        assert!(model.is_default);
        assert_eq!(
            model.default_reasoning_effort,
            Some(ReasoningEffort::Medium)
        );
        assert_eq!(
            model
                .supported_reasoning_efforts
                .iter()
                .map(|option| option.effort)
                .collect::<Vec<_>>(),
            vec![ReasoningEffort::Low, ReasoningEffort::Ultra]
        );
    }

    #[test]
    fn schema_overrides_merge_from_disk_and_fall_back_when_invalid() {
        let dir = tempfile::tempdir().expect("schema dir");

        // 유효한 오버라이드: 내장 mode 항목 재구성(선택지 축소) + 화이트리스트 항목 enum화
        let overrides = json!({
            "providers": {"claude": [
                {"key": "mode", "label": "모드", "kind": "enum",
                 "options": [{"value": "plan", "label": "읽기"}], "defaultValue": "plan"},
                {"key": "fallbackModel", "label": "예비 모델", "kind": "enum",
                 "options": [{"value": "claude-sonnet-5", "label": "Sonnet 5"}]}
            ]},
            "updatedAt": 1
        });
        fs::write(
            dir.path().join(CHAT_SETTINGS_SCHEMA_FILE),
            overrides.to_string(),
        )
        .expect("write overrides");
        let fields = merged_setting_fields(ProviderId::Claude, Some(dir.path()));
        let mode = fields
            .iter()
            .find(|field| field.key == "mode")
            .expect("mode");
        assert_eq!(mode.options.len(), 1);
        assert_eq!(mode.default_value.as_deref(), Some("plan"));
        assert!(fields
            .iter()
            .any(|field| field.key == "fallbackModel" && field.options.len() == 1));

        // 내장 항목에 없는 선택지 값을 끼워 넣으면 검증 실패 → 전체 오버라이드 폐기, 내장 폴백
        let hostile = json!({
            "providers": {"claude": [
                {"key": "mode", "label": "모드", "kind": "enum",
                 "options": [{"value": "godMode", "label": "무제한"}], "defaultValue": "godMode"}
            ]}
        });
        fs::write(
            dir.path().join(CHAT_SETTINGS_SCHEMA_FILE),
            hostile.to_string(),
        )
        .expect("write hostile overrides");
        let fields = merged_setting_fields(ProviderId::Claude, Some(dir.path()));
        let mode = fields
            .iter()
            .find(|field| field.key == "mode")
            .expect("mode");
        assert_eq!(mode.options.len(), 3);
        assert_eq!(mode.default_value.as_deref(), Some("workspace"));

        // 화이트리스트에 없는 새 항목 제안은 검증 단계에서 거부된다
        let rogue = vec![ChatSettingField {
            key: "skipChecks".to_owned(),
            label: "검사 생략".to_owned(),
            detail: None,
            kind: ChatSettingFieldKind::Enum,
            options: vec![setting_option("true", "켜기", "", false)],
            default_value: None,
        }];
        assert!(validate_schema_fields(ProviderId::Claude, &rogue).is_err());
    }

    #[test]
    fn dynamic_settings_are_whitelisted_and_validated() {
        let mut settings = BTreeMap::new();
        settings.insert("fallbackModel".to_owned(), "claude-sonnet-5".to_owned());
        let validated = validate_dynamic_settings(ProviderId::Claude, &settings)
            .expect("fallbackModel is whitelisted for Claude");
        assert_eq!(
            validated.get("fallbackModel").map(String::as_str),
            Some("claude-sonnet-5")
        );

        // 화이트리스트에 없는 키는 오류로 드러난다 (조용한 무시 금지).
        let mut unknown = BTreeMap::new();
        unknown.insert("dangerouslySkipChecks".to_owned(), "true".to_owned());
        assert!(validate_dynamic_settings(ProviderId::Claude, &unknown).is_err());

        // 값 규칙(식별자 문자 집합) 위반도 오류.
        let mut invalid = BTreeMap::new();
        invalid.insert("fallbackModel".to_owned(), "bad value; rm -rf".to_owned());
        assert!(validate_dynamic_settings(ProviderId::Claude, &invalid).is_err());

        // Claude 전용 키는 다른 provider에서 거부된다.
        assert!(validate_dynamic_settings(ProviderId::Codex, &settings).is_err());

        // 빈 값은 "설정 안 함"으로 취급되어 통과하되 결과에서 빠진다.
        let mut empty = BTreeMap::new();
        empty.insert("fallbackModel".to_owned(), "  ".to_owned());
        let validated = validate_dynamic_settings(ProviderId::Claude, &empty)
            .expect("blank value clears the setting");
        assert!(validated.is_empty());
    }

    #[test]
    fn claude_arguments_include_validated_dynamic_settings() {
        let mut runtime = fixture_runtime(ProviderId::Claude);
        runtime
            .dynamic_settings
            .insert("fallbackModel".to_owned(), "claude-sonnet-5".to_owned());
        let args = claude_stream_cli_args(&runtime, false);
        assert!(args
            .windows(2)
            .any(|pair| pair == ["--fallback-model", "claude-sonnet-5"]));
    }

    #[test]
    fn provider_setting_fields_gate_auto_review_to_codex() {
        for source in [ProviderId::Claude, ProviderId::Antigravity] {
            let fields = provider_setting_fields(source);
            let approval = fields
                .iter()
                .find(|field| field.key == "approvalMode")
                .expect("approvalMode field");
            let auto_review = approval
                .options
                .iter()
                .find(|option| option.value == "autoReview")
                .expect("autoReview option");
            assert!(auto_review.disabled);
            assert_eq!(approval.default_value.as_deref(), Some("manual"));
        }

        let fields = provider_setting_fields(ProviderId::Codex);
        let approval = fields
            .iter()
            .find(|field| field.key == "approvalMode")
            .expect("approvalMode field");
        let auto_review = approval
            .options
            .iter()
            .find(|option| option.value == "autoReview")
            .expect("autoReview option");
        assert!(!auto_review.disabled);
        assert_eq!(approval.default_value.as_deref(), Some("autoReview"));

        let mode = fields
            .iter()
            .find(|field| field.key == "mode")
            .expect("mode field");
        assert_eq!(mode.options.len(), 3);
        assert_eq!(mode.default_value.as_deref(), Some("workspace"));
    }

    #[test]
    fn full_access_arguments_use_provider_approved_flags() {
        let claude = fixture_runtime_with_mode(ProviderId::Claude, ChatMode::FullAccess);
        let claude_args = claude_stream_cli_args(&claude, false);
        assert!(claude_args
            .windows(2)
            .any(|args| args == ["--permission-mode", "bypassPermissions"]));

        let antigravity = fixture_runtime_with_mode(ProviderId::Antigravity, ChatMode::FullAccess);
        let antigravity_args = antigravity_stream_cli_args(&antigravity, "hello", None);
        assert!(antigravity_args
            .iter()
            .any(|arg| arg == "--dangerously-skip-permissions"));
    }

    #[test]
    fn codex_approval_settings_match_the_selected_mode() {
        let mut runtime = fixture_runtime(ProviderId::Codex);

        runtime.approval_mode = ChatApprovalMode::AutoReview;
        assert_eq!(
            codex_approval_settings(&runtime),
            ("on-request", "auto_review")
        );

        runtime.approval_mode = ChatApprovalMode::Manual;
        assert_eq!(codex_approval_settings(&runtime), ("on-request", "user"));

        runtime.unattended = true;
        assert_eq!(codex_approval_settings(&runtime), ("never", "user"));

        runtime.unattended = false;
        runtime.approval_mode = ChatApprovalMode::Never;
        assert_eq!(codex_approval_settings(&runtime), ("never", "user"));
    }

    #[test]
    fn only_aia_codex_sessions_are_ephemeral() {
        assert!(codex_session_is_ephemeral(ChatProfile::Aia));
        assert!(!codex_session_is_ephemeral(ChatProfile::Standard));
    }

    #[test]
    fn auto_review_falls_back_to_manual_for_other_providers() {
        assert_eq!(
            ChatApprovalMode::AutoReview.for_provider(ProviderId::Codex),
            ChatApprovalMode::AutoReview
        );
        assert_eq!(
            ChatApprovalMode::AutoReview.for_provider(ProviderId::Claude),
            ChatApprovalMode::Manual
        );
        assert_eq!(
            ChatApprovalMode::AutoReview.for_provider(ProviderId::Antigravity),
            ChatApprovalMode::Manual
        );
    }

    #[test]
    fn never_mode_only_auto_accepts_inside_full_access() {
        let mut runtime = fixture_runtime(ProviderId::Codex);
        runtime.approval_mode = ChatApprovalMode::Never;
        assert_eq!(
            automatic_approval_decision(&runtime),
            Some(ChatApprovalDecision::Decline)
        );

        runtime.mode = ChatMode::FullAccess;
        assert_eq!(
            automatic_approval_decision(&runtime),
            Some(ChatApprovalDecision::AcceptForSession)
        );
    }

    #[test]
    fn antigravity_prompt_is_bound_to_print_mode() {
        let runtime = fixture_runtime(ProviderId::Antigravity);
        let args = antigravity_stream_cli_args(&runtime, "hello", Some("conversation-123"));
        assert!(args
            .windows(2)
            .any(|args| args == ["--output-format", "stream-json"]));
        assert!(args
            .windows(2)
            .any(|args| args == ["--conversation", "conversation-123"]));
        assert!(args.windows(2).any(|args| args == ["--print", "hello"]));
        assert!(!args.iter().any(|arg| arg == "--prompt"));
    }

    #[test]
    fn claude_turn_is_written_as_a_stream_json_user_message() {
        let message = PendingChatMessage {
            id: "message".to_owned(),
            text: "hello".to_owned(),
            attachments: Vec::new(),
        };
        assert_eq!(
            claude_user_message(&message).expect("claude user message"),
            json!({
                "type": "user",
                "message": {"role": "user", "content": [{"type": "text", "text": "hello"}]},
                "parent_tool_use_id": null,
            })
        );
        assert_eq!(
            claude_control_request("interrupt-1", "interrupt"),
            json!({
                "type": "control_request",
                "request_id": "interrupt-1",
                "request": {"subtype": "interrupt"},
            })
        );
    }

    #[test]
    fn attachment_upload_sniffs_images_and_stays_in_app_storage() {
        let data = tempfile::tempdir().expect("app data");
        let mut runtime = fixture_runtime(ProviderId::Codex);
        runtime.app_data_dir = Some(data.path().to_path_buf());
        let png = b"\x89PNG\r\n\x1a\ncontent".to_vec();

        let file = runtime
            .upload_input_file("화면.png", "application/octet-stream", png.clone())
            .expect("upload image");
        let download = runtime
            .input_file_download(&file.id)
            .expect("download image");

        assert_eq!(file.kind, ChatInputFileKind::Image);
        assert_eq!(file.media_type, "image/png");
        assert_eq!(download.bytes, png);
        let stored = runtime
            .state
            .lock()
            .expect("runtime state")
            .uploads
            .get(&file.id)
            .expect("stored upload")
            .path
            .clone();
        assert!(stored.starts_with(
            fs::canonicalize(data.path().join("chat-inputs/chat")).expect("attachment root")
        ));
        assert!(runtime
            .upload_input_file("../secret.txt", "text/plain", b"secret".to_vec())
            .is_err());
    }

    #[test]
    fn provider_inputs_keep_native_images_and_named_files() {
        let data = tempfile::tempdir().expect("files");
        let image_path = data.path().join("image.upload");
        let file_path = data.path().join("notes.upload");
        fs::write(&image_path, b"image bytes").expect("image");
        fs::write(&file_path, b"notes").expect("notes");
        let message = PendingChatMessage {
            id: "message".to_owned(),
            text: "검토해줘".to_owned(),
            attachments: vec![
                StoredChatInputFile {
                    file: ChatInputFile {
                        id: "image".to_owned(),
                        name: "화면.png".to_owned(),
                        media_type: "image/png".to_owned(),
                        size_bytes: 11,
                        kind: ChatInputFileKind::Image,
                    },
                    path: image_path.clone(),
                    used: true,
                },
                StoredChatInputFile {
                    file: ChatInputFile {
                        id: "file".to_owned(),
                        name: "요구사항.txt".to_owned(),
                        media_type: "text/plain".to_owned(),
                        size_bytes: 5,
                        kind: ChatInputFileKind::File,
                    },
                    path: file_path.clone(),
                    used: true,
                },
            ],
        };

        let codex = codex_turn_input(&message);
        assert_eq!(codex[1]["type"], "localImage");
        assert_eq!(codex[1]["path"], image_path.to_string_lossy().as_ref());
        assert_eq!(codex[2]["type"], "mention");
        assert_eq!(codex[2]["name"], "요구사항.txt");
        assert_eq!(codex[2]["path"], file_path.to_string_lossy().as_ref());

        let claude = claude_user_message(&message).expect("claude message");
        let content = claude["message"]["content"].as_array().expect("content");
        assert!(content[0]["text"]
            .as_str()
            .expect("text")
            .contains("요구사항.txt"));
        assert_eq!(content[1]["type"], "image");
        assert_eq!(content[1]["source"]["media_type"], "image/png");
    }

    #[test]
    fn attended_claude_uses_stdio_permission_prompts() {
        let attended = fixture_runtime(ProviderId::Claude);
        let attended_args = claude_stream_cli_args(&attended, false);
        assert!(attended_args
            .windows(2)
            .any(|args| args == ["--permission-prompt-tool", "stdio"]));

        let mut unattended = fixture_runtime(ProviderId::Claude);
        unattended.unattended = true;
        let unattended_args = claude_stream_cli_args(&unattended, false);
        assert!(!unattended_args
            .windows(2)
            .any(|args| args == ["--permission-prompt-tool", "stdio"]));

        let mut without_approvals = fixture_runtime(ProviderId::Claude);
        without_approvals.approval_mode = ChatApprovalMode::Never;
        let without_approval_args = claude_stream_cli_args(&without_approvals, false);
        assert!(!without_approval_args
            .windows(2)
            .any(|args| args == ["--permission-prompt-tool", "stdio"]));
    }

    #[test]
    fn claude_workspace_mode_accepts_edits_for_attended_and_unattended_sessions() {
        for unattended in [false, true] {
            let mut runtime = fixture_runtime(ProviderId::Claude);
            runtime.unattended = unattended;
            let args = claude_stream_cli_args(&runtime, false);
            assert!(args
                .windows(2)
                .any(|args| args == ["--permission-mode", "acceptEdits"]));
            assert!(!args.iter().any(|arg| arg == "manual"));
        }
    }

    #[test]
    fn claude_permission_request_waits_for_an_interactive_decision() {
        let runtime = Arc::new(fixture_runtime(ProviderId::Claude));
        runtime.state.lock().expect("runtime state").phase = ChatPhase::Running;

        handle_stream_cli_message(
            &runtime,
            json!({
                "type": "control_request",
                "request_id": "permission-1",
                "request": {
                    "subtype": "can_use_tool",
                    "tool_name": "Bash",
                    "input": {"command": "npm run build"},
                    "title": "Claude wants to run npm run build",
                    "permission_suggestions": [{
                        "type": "addRules",
                        "rules": [{"toolName": "Bash", "ruleContent": "npm run build"}],
                        "behavior": "allow",
                        "destination": "projectSettings"
                    }]
                }
            }),
        );

        let state = runtime.state.lock().expect("runtime state");
        assert_eq!(state.phase, ChatPhase::WaitingApproval);
        assert_eq!(state.pending_approvals.len(), 1);
        assert!(state.replay.iter().any(|event| matches!(
            event,
            ChatEvent::Approval { title, interactive: true, options, .. }
                if title == "Claude wants to run npm run build"
                    && options.contains(&ChatApprovalDecision::Accept)
                    && options.contains(&ChatApprovalDecision::AcceptForSession)
        )));
    }

    #[test]
    fn detached_chat_replays_pending_approval_and_keeps_attention_item() {
        let runtime = Arc::new(fixture_runtime(ProviderId::Codex));
        {
            let mut state = runtime.state.lock().expect("runtime state");
            state.phase = ChatPhase::Running;
            state.provider_session_id = Some("thread-123".to_owned());
        }
        handle_codex_request(
            &runtime,
            "item/commandExecution/requestApproval",
            json!(41),
            json!({"command": "npm run build"}),
        );
        for index in 0..600 {
            runtime.emit(ChatEvent::Tool {
                id: format!("log-{index}"),
                name: "로그".to_owned(),
                status: "log".to_owned(),
                detail: None,
                output: Some(index.to_string()),
                append: false,
            });
        }

        let first = runtime.attach().expect("first attachment");
        runtime.detach().expect("detach");
        drop(first);
        let second = runtime.attach().expect("reattach");
        let replay = second.events.try_iter().collect::<Vec<_>>();

        assert!(replay.iter().any(|event| matches!(
            event,
            ChatEvent::Approval { title, interactive: true, .. }
                if title == "명령 실행 승인"
        )));
        assert!(replay.iter().any(|event| matches!(
            event,
            ChatEvent::State { session } if session.state == ChatPhase::WaitingApproval
        )));
        let attention = runtime.attention.snapshot().expect("attention snapshot");
        assert_eq!(attention.pending_count, 1);
        assert_eq!(attention.unread_count, 1);
        assert_eq!(
            attention.items[0].provider_session_id.as_deref(),
            Some("thread-123")
        );
        assert!(attention.items[0]
            .approval_id
            .as_deref()
            .is_some_and(|id| id.starts_with("approval-")));
    }

    #[test]
    fn attach_takes_over_an_existing_subscriber() {
        let runtime = Arc::new(fixture_runtime(ProviderId::Codex));

        let first = runtime.attach().expect("first attachment");
        let second = runtime.attach().expect("takeover attachment");
        assert_ne!(first.generation, second.generation);

        // 밀려난 화면은 재연결을 멈추라는 신호를 마지막으로 받는다.
        let first_events = first.events.try_iter().collect::<Vec<_>>();
        assert!(matches!(first_events.last(), Some(ChatEvent::TakenOver)));

        // 옛 연결의 정리는 새 구독을 지우지 않는다.
        runtime
            .detach_attachment(first.generation)
            .expect("stale detach");
        assert!(runtime
            .state
            .lock()
            .expect("runtime state")
            .subscriber
            .is_some());

        // 현재 세대의 정리는 구독을 지운다.
        runtime
            .detach_attachment(second.generation)
            .expect("current detach");
        assert!(runtime
            .state
            .lock()
            .expect("runtime state")
            .subscriber
            .is_none());
    }

    #[test]
    fn resolved_approval_is_removed_and_completed_turn_can_be_marked_read() {
        let runtime = fixture_runtime(ProviderId::Claude);
        runtime.emit(ChatEvent::Approval {
            id: "approval-1".to_owned(),
            kind: "permission".to_owned(),
            title: "권한 승인".to_owned(),
            detail: None,
            options: vec![ChatApprovalDecision::Accept],
            interactive: true,
        });
        runtime.emit(ChatEvent::ApprovalResolved {
            id: "approval-1".to_owned(),
            decision: ChatApprovalDecision::Accept,
        });
        runtime.emit(ChatEvent::Turn {
            id: "turn-1".to_owned(),
            status: "completed".to_owned(),
            timestamp: 123,
        });

        let attention = runtime.attention.snapshot().expect("attention snapshot");
        assert_eq!(attention.pending_count, 0);
        assert_eq!(attention.unread_count, 1);
        assert_eq!(attention.items[0].kind, ChatAttentionKind::Completed);
        let read = runtime
            .attention
            .mark_read(&attention.items[0].id)
            .expect("mark read");
        assert_eq!(read.unread_count, 0);
        assert!(read.items[0].read);
    }

    #[test]
    fn running_turn_stays_in_attention_until_terminal_event_replaces_it() {
        let mut runtime = fixture_runtime(ProviderId::Codex);
        runtime.unattended = true;
        runtime.emit(ChatEvent::Turn {
            id: "turn-1".to_owned(),
            status: "started".to_owned(),
            timestamp: 100,
        });

        let running = runtime.attention.snapshot().expect("running attention");
        assert_eq!(running.unread_count, 1);
        assert_eq!(running.items.len(), 1);
        assert_eq!(running.items[0].kind, ChatAttentionKind::Running);
        assert!(running.items[0].unattended);

        let read = runtime
            .attention
            .mark_read(&running.items[0].id)
            .expect("mark running read");
        assert_eq!(read.unread_count, 0);
        assert_eq!(read.items.len(), 1);
        assert_eq!(read.items[0].kind, ChatAttentionKind::Running);
        assert!(read.items[0].read);

        runtime.emit(ChatEvent::Turn {
            id: "turn-1".to_owned(),
            status: "completed".to_owned(),
            timestamp: 200,
        });

        let completed = runtime.attention.snapshot().expect("completed attention");
        assert_eq!(completed.unread_count, 1);
        assert_eq!(completed.items.len(), 1);
        assert_eq!(completed.items[0].kind, ChatAttentionKind::Completed);
        assert!(completed.items[0].unattended);
        assert!(!completed.items[0].read);
    }

    #[test]
    fn terminal_chat_state_removes_a_stale_running_attention_item() {
        let runtime = fixture_runtime(ProviderId::Codex);
        runtime.emit(ChatEvent::Turn {
            id: "turn-1".to_owned(),
            status: "started".to_owned(),
            timestamp: 100,
        });
        assert_eq!(
            runtime
                .attention
                .snapshot()
                .expect("running attention")
                .items
                .len(),
            1
        );

        runtime.set_phase(ChatPhase::Stopped);

        assert!(runtime
            .attention
            .snapshot()
            .expect("stopped attention")
            .items
            .is_empty());
    }

    #[test]
    fn clear_read_attention_keeps_running_approval_and_unread_items() {
        let runtime = fixture_runtime(ProviderId::Codex);
        runtime.emit(ChatEvent::Turn {
            id: "turn-running".to_owned(),
            status: "started".to_owned(),
            timestamp: 100,
        });
        runtime.emit(ChatEvent::Turn {
            id: "turn-completed".to_owned(),
            status: "completed".to_owned(),
            timestamp: 200,
        });
        runtime.emit(ChatEvent::Turn {
            id: "turn-failed".to_owned(),
            status: "failed".to_owned(),
            timestamp: 300,
        });
        runtime.emit(ChatEvent::Approval {
            id: "approval-1".to_owned(),
            kind: "command".to_owned(),
            title: "명령 실행 승인".to_owned(),
            detail: None,
            options: vec![ChatApprovalDecision::Accept],
            interactive: true,
        });

        let before = runtime.attention.snapshot().expect("attention snapshot");
        let running_id = before
            .items
            .iter()
            .find(|item| item.kind == ChatAttentionKind::Running)
            .expect("running attention")
            .id
            .clone();
        let completed_id = before
            .items
            .iter()
            .find(|item| item.kind == ChatAttentionKind::Completed)
            .expect("completed attention")
            .id
            .clone();
        runtime
            .attention
            .mark_read(&running_id)
            .expect("mark running read");
        runtime
            .attention
            .mark_read(&completed_id)
            .expect("mark completed read");

        let cleared = runtime
            .attention
            .clear_read()
            .expect("clear read attention");

        assert_eq!(cleared.items.len(), 3);
        assert!(!cleared
            .items
            .iter()
            .any(|item| item.kind == ChatAttentionKind::Completed));
        assert!(cleared
            .items
            .iter()
            .any(|item| item.kind == ChatAttentionKind::Running && item.read));
        assert!(cleared
            .items
            .iter()
            .any(|item| item.kind == ChatAttentionKind::Failed && !item.read));
        assert_eq!(cleared.pending_count, 1);
        assert_eq!(cleared.unread_count, 2);
    }

    #[test]
    fn dismiss_attention_removes_one_item_but_rejects_approval_and_unknown_ids() {
        let runtime = fixture_runtime(ProviderId::Codex);
        runtime.emit(ChatEvent::Turn {
            id: "turn-completed".to_owned(),
            status: "completed".to_owned(),
            timestamp: 100,
        });
        runtime.emit(ChatEvent::Turn {
            id: "turn-failed".to_owned(),
            status: "failed".to_owned(),
            timestamp: 200,
        });
        runtime.emit(ChatEvent::Approval {
            id: "approval-1".to_owned(),
            kind: "command".to_owned(),
            title: "명령 실행 승인".to_owned(),
            detail: None,
            options: vec![ChatApprovalDecision::Accept],
            interactive: true,
        });

        let before = runtime.attention.snapshot().expect("attention snapshot");
        assert_eq!(before.items.len(), 3);
        let completed_id = before
            .items
            .iter()
            .find(|item| item.kind == ChatAttentionKind::Completed)
            .expect("completed attention")
            .id
            .clone();
        let approval_id = before
            .items
            .iter()
            .find(|item| item.kind == ChatAttentionKind::Approval)
            .expect("approval attention")
            .id
            .clone();

        let dismissed = runtime
            .attention
            .dismiss(&completed_id)
            .expect("dismiss completed item");
        assert_eq!(dismissed.items.len(), 2);
        assert!(!dismissed.items.iter().any(|item| item.id == completed_id));
        assert!(dismissed
            .items
            .iter()
            .any(|item| item.kind == ChatAttentionKind::Failed));

        assert!(runtime.attention.dismiss(&approval_id).is_err());
        assert!(runtime.attention.dismiss("missing-id").is_err());
        assert_eq!(
            runtime
                .attention
                .snapshot()
                .expect("attention snapshot")
                .items
                .len(),
            2
        );
    }

    #[test]
    fn detached_session_runtime_can_be_found_and_attached_again() {
        let supervisor = ChatSupervisor::new();
        let runtime = Arc::new(fixture_runtime(ProviderId::Codex));
        {
            let mut state = runtime.state.lock().expect("runtime state");
            state.phase = ChatPhase::Running;
            state.provider_session_id = Some("thread-123".to_owned());
        }
        supervisor
            .inner
            .chats
            .lock()
            .expect("chat registry")
            .insert(runtime.chat_id.clone(), Arc::clone(&runtime));

        let detached = supervisor
            .detached_chat_for_session(ProviderId::Codex, "thread-123")
            .expect("detached runtime")
            .expect("matching runtime");
        assert_eq!(detached.chat_id, runtime.chat_id);
        assert_eq!(detached.state, ChatPhase::Running);

        let attachment = supervisor.attach(&detached.chat_id).expect("reattach");
        assert!(supervisor
            .detached_chat_for_session(ProviderId::Codex, "thread-123")
            .expect("attached lookup")
            .is_none());
        supervisor.detach(&detached.chat_id).expect("detach again");
        drop(attachment);
        assert!(supervisor
            .detached_chat_for_session(ProviderId::Codex, "thread-123")
            .expect("detached lookup")
            .is_some());

        runtime.stop().expect("stop runtime");
        assert!(supervisor
            .detached_chat_for_session(ProviderId::Codex, "thread-123")
            .expect("stopped lookup")
            .is_none());
    }

    #[test]
    fn live_chats_only_lists_attended_non_terminal_runtimes_for_the_profile() {
        let supervisor = ChatSupervisor::new();
        let mut first = fixture_runtime(ProviderId::Codex);
        first.chat_id = "first".to_owned();
        first.started_at = 10;

        let mut second = fixture_runtime(ProviderId::Claude);
        second.chat_id = "second".to_owned();
        second.started_at = 20;
        second.state.lock().expect("second state").phase = ChatPhase::Running;

        let mut unattended = fixture_runtime(ProviderId::Codex);
        unattended.chat_id = "unattended".to_owned();
        unattended.unattended = true;

        let mut aia = fixture_runtime(ProviderId::Codex);
        aia.chat_id = "aia".to_owned();
        aia.profile = ChatProfile::Aia;

        let mut stopped = fixture_runtime(ProviderId::Codex);
        stopped.chat_id = "stopped".to_owned();
        stopped.state.lock().expect("stopped state").phase = ChatPhase::Stopped;

        let runtimes = [first, second, unattended, aia, stopped]
            .into_iter()
            .map(|runtime| (runtime.chat_id.clone(), Arc::new(runtime)))
            .collect();
        *supervisor.inner.chats.lock().expect("chat registry") = runtimes;

        let standard = supervisor
            .live_chats(ChatProfile::Standard)
            .expect("standard live chats");
        assert_eq!(
            standard
                .iter()
                .map(|chat| chat.chat_id.as_str())
                .collect::<Vec<_>>(),
            vec!["first", "second"]
        );
        supervisor.detach("first").expect("detach first");
        assert_eq!(
            supervisor
                .live_chats(ChatProfile::Standard)
                .expect("detached live chats")
                .len(),
            2
        );
        supervisor.stop("first").expect("stop first");
        assert_eq!(
            supervisor
                .live_chats(ChatProfile::Standard)
                .expect("remaining live chats")
                .iter()
                .map(|chat| chat.chat_id.as_str())
                .collect::<Vec<_>>(),
            vec!["second"]
        );

        let aia = supervisor
            .live_chats(ChatProfile::Aia)
            .expect("AIA live chats");
        assert_eq!(aia.len(), 1);
        assert_eq!(aia[0].chat_id, "aia");
    }

    #[test]
    fn stop_managed_returns_a_receipt_and_repeat_calls_are_safe() {
        let supervisor = ChatSupervisor::new();
        let runtime = Arc::new(fixture_runtime(ProviderId::Claude));
        runtime.state.lock().expect("runtime state").phase = ChatPhase::Running;
        supervisor
            .inner
            .chats
            .lock()
            .expect("chat registry")
            .insert(runtime.chat_id.clone(), Arc::clone(&runtime));

        let receipt = supervisor.stop_managed("chat").expect("stop receipt");
        assert_eq!(receipt.previous_state, ChatPhase::Running);
        assert_eq!(receipt.state, ChatPhase::Stopped);
        assert!(!receipt.already_stopped);
        assert_eq!(receipt.source, ProviderId::Claude);

        let repeat = supervisor.stop_managed("chat").expect("repeat receipt");
        assert!(repeat.already_stopped);
        assert_eq!(repeat.previous_state, ChatPhase::Stopped);
        assert!(supervisor.stop_managed("missing").is_err());
    }

    #[test]
    fn stop_provider_chats_covers_all_profiles_and_skips_other_providers() {
        let supervisor = ChatSupervisor::new();
        let mut standard = fixture_runtime(ProviderId::Codex);
        standard.chat_id = "standard".to_owned();
        standard.state.lock().expect("standard state").phase = ChatPhase::Running;

        let mut aia = fixture_runtime(ProviderId::Codex);
        aia.chat_id = "aia".to_owned();
        aia.profile = ChatProfile::Aia;
        aia.state.lock().expect("aia state").phase = ChatPhase::WaitingApproval;

        let mut unattended = fixture_runtime(ProviderId::Codex);
        unattended.chat_id = "unattended".to_owned();
        unattended.unattended = true;

        let mut stopped = fixture_runtime(ProviderId::Codex);
        stopped.chat_id = "stopped".to_owned();
        stopped.state.lock().expect("stopped state").phase = ChatPhase::Stopped;

        let mut claude = fixture_runtime(ProviderId::Claude);
        claude.chat_id = "claude".to_owned();
        claude.state.lock().expect("claude state").phase = ChatPhase::Running;

        let runtimes = [standard, aia, unattended, stopped, claude]
            .into_iter()
            .map(|runtime| (runtime.chat_id.clone(), Arc::new(runtime)))
            .collect();
        *supervisor.inner.chats.lock().expect("chat registry") = runtimes;

        let report = supervisor
            .stop_provider_chats(ProviderId::Codex)
            .expect("stop report");
        assert_eq!(report.provider, ProviderId::Codex);
        assert_eq!(report.requested_count, 3, "standard·aia·unattended만 포함");
        assert_eq!(report.stopped_count, 3);
        assert_eq!(report.forced_count, 0, "정상 종료면 강제 종료 승격 없음");
        assert!(report.failed.is_empty());
        assert_eq!(report.remaining_runtime_count, 0);

        for chat in supervisor.provider_chats(ProviderId::Codex).expect("codex") {
            assert_eq!(chat.state, ChatPhase::Stopped, "{}", chat.chat_id);
        }
        let claude_chats = supervisor
            .provider_chats(ProviderId::Claude)
            .expect("claude");
        assert_eq!(claude_chats.len(), 1);
        assert_eq!(
            claude_chats[0].state,
            ChatPhase::Running,
            "다른 공급자는 유지"
        );

        let repeat = supervisor
            .stop_provider_chats(ProviderId::Codex)
            .expect("repeat report");
        assert_eq!(repeat.requested_count, 0, "이미 종료된 항목은 제외");
    }

    #[cfg(unix)]
    #[test]
    fn ensure_pid_terminated_kills_a_live_process() {
        let child = std::process::Command::new("/bin/sleep")
            .arg("30")
            .spawn()
            .expect("spawn sleep");
        let pid = child.id();
        ensure_pid_terminated(pid).expect("force kill");
        // 종료·회수까지 끝났으므로 시그널 0 전송은 실패해야 한다.
        assert_eq!(unsafe { libc::kill(pid as libc::pid_t, 0) }, -1);
        drop(child);
    }

    #[cfg(unix)]
    #[test]
    fn stop_with_escalation_terminates_a_live_child_process() {
        let runtime = fixture_runtime(ProviderId::Claude);
        runtime.state.lock().expect("runtime state").phase = ChatPhase::Running;
        let child = std::process::Command::new("/bin/sleep")
            .arg("30")
            .spawn()
            .expect("spawn sleep");
        let pid = child.id();
        *runtime.child.lock().expect("child slot") = Some(child);

        let forced = runtime.stop_with_escalation().expect("stop");
        assert!(!forced, "정상 kill 경로가 성공하면 강제 승격이 아니다");
        assert_eq!(
            runtime.state.lock().expect("runtime state").phase,
            ChatPhase::Stopped
        );
        assert!(runtime.child.lock().expect("child slot").is_none());
        assert_eq!(unsafe { libc::kill(pid as libc::pid_t, 0) }, -1);
    }

    #[test]
    fn claude_accept_for_session_is_scoped_to_the_runtime_session() {
        let response = approval_response(
            &PendingApproval::Claude {
                request_id: "permission-1".to_owned(),
                input: json!({"command": "npm run build"}),
                permission_suggestions: vec![
                    json!({
                        "type": "addRules",
                        "rules": [{"toolName": "Bash", "ruleContent": "npm run build"}],
                        "behavior": "allow",
                        "destination": "projectSettings"
                    }),
                    json!({
                        "type": "setMode",
                        "mode": "bypassPermissions",
                        "destination": "userSettings"
                    }),
                ],
            },
            ChatApprovalDecision::AcceptForSession,
        );

        assert_eq!(
            response.pointer("/type").and_then(Value::as_str),
            Some("control_response")
        );
        assert_eq!(
            response
                .pointer("/response/response/behavior")
                .and_then(Value::as_str),
            Some("allow")
        );
        let updates = response
            .pointer("/response/response/updatedPermissions")
            .and_then(Value::as_array)
            .expect("session updates");
        assert_eq!(updates.len(), 1);
        assert_eq!(
            updates[0].get("destination").and_then(Value::as_str),
            Some("session")
        );
    }

    #[test]
    fn claude_result_with_denials_is_not_presented_as_plain_completion() {
        let runtime = Arc::new(fixture_runtime(ProviderId::Claude));
        {
            let mut state = runtime.state.lock().expect("runtime state");
            state.phase = ChatPhase::Running;
            state.active_turn_id = Some("turn-1".to_owned());
        }

        handle_stream_cli_message(
            &runtime,
            json!({
                "type": "result",
                "is_error": false,
                "permission_denials": [{"tool_name": "Edit", "tool_input": {"file_path": "/workspace/a.rs"}}]
            }),
        );

        let state = runtime.state.lock().expect("runtime state");
        assert_eq!(state.phase, ChatPhase::Ready);
        assert!(state.replay.iter().any(|event| matches!(
            event,
            ChatEvent::Approval { title, interactive: false, .. }
                if title == "CLI 권한 자동 거절"
        )));
        assert!(state.replay.iter().any(|event| matches!(
            event,
            ChatEvent::Turn { status, .. } if status == "completedWithDenials"
        )));
    }

    #[test]
    fn claude_interrupt_result_keeps_the_process_session_ready() {
        let runtime = Arc::new(fixture_runtime(ProviderId::Claude));
        {
            let mut state = runtime.state.lock().expect("runtime state");
            state.phase = ChatPhase::Running;
            state.active_turn_id = Some("turn-1".to_owned());
            state.claude_interrupt_pending = true;
        }

        handle_stream_cli_message(
            &runtime,
            json!({"type": "result", "is_error": false, "result": "interrupted"}),
        );

        let state = runtime.state.lock().expect("runtime state");
        assert_eq!(state.phase, ChatPhase::Ready);
        assert!(!state.claude_interrupt_pending);
        assert!(state.replay.iter().any(|event| matches!(
            event,
            ChatEvent::Turn { id, status, .. }
                if id == "turn-1" && status == "interrupted"
        )));
    }

    #[test]
    fn claude_interrupted_error_result_is_reported_as_interruption_not_failure() {
        let runtime = Arc::new(fixture_runtime(ProviderId::Claude));
        {
            let mut state = runtime.state.lock().expect("runtime state");
            state.phase = ChatPhase::Running;
            state.active_turn_id = Some("turn-1".to_owned());
            state.claude_interrupt_pending = true;
        }

        // 승인 취소(deny+interrupt) 뒤 CLI는 result 문자열 없이 is_error를 보낸다.
        handle_stream_cli_message(&runtime, json!({"type": "result", "is_error": true}));

        let state = runtime.state.lock().expect("runtime state");
        assert_eq!(state.phase, ChatPhase::Ready);
        assert!(!state.claude_interrupt_pending);
        assert!(state.replay.iter().any(|event| matches!(
            event,
            ChatEvent::Turn { id, status, .. }
                if id == "turn-1" && status == "interrupted"
        )));
        assert!(!state
            .replay
            .iter()
            .any(|event| matches!(event, ChatEvent::Error { .. })));
    }

    #[test]
    fn codex_session_app_url_is_restricted_to_safe_thread_ids() {
        assert_eq!(
            provider_session_app_url(ProviderId::Codex, "019fd109-c00e-7993-995a-c80fee5c429c")
                .expect("Codex deep link"),
            "codex://threads/019fd109-c00e-7993-995a-c80fee5c429c"
        );
        assert!(provider_session_app_url(ProviderId::Claude, "abc").is_err());
        assert!(provider_session_app_url(ProviderId::Codex, "abc/../../settings").is_err());
    }

    #[test]
    fn antigravity_stream_events_emit_response_and_tool_state() {
        let runtime = Arc::new(fixture_runtime(ProviderId::Antigravity));
        {
            let mut state = runtime.state.lock().expect("runtime state");
            state.phase = ChatPhase::Running;
            state.turn_count = 1;
        }
        handle_stream_cli_message(
            &runtime,
            json!({"event":"init","conversation_id":"conversation-123"}),
        );
        handle_stream_cli_message(
            &runtime,
            json!({
                "event":"step_update",
                "step_update":{
                    "step_index":3,
                    "state":"ACTIVE",
                    "step_type":"tool",
                    "tool_name":"run_command",
                    "tool_info":{"parameters":{"CommandLine":"pwd"}}
                }
            }),
        );
        handle_stream_cli_message(
            &runtime,
            json!({
                "event":"step_update",
                "step_update":{
                    "step_index":3,
                    "state":"DONE",
                    "step_type":"tool",
                    "tool_name":"run_command",
                    "tool_info":{
                        "parameters":{"CommandLine":"pwd"},
                        "output":"/workspace"
                    }
                }
            }),
        );
        handle_stream_cli_message(
            &runtime,
            json!({
                "event":"result",
                "result":{
                    "conversation_id":"conversation-123",
                    "status":"SUCCESS",
                    "response":"AGY_OK\n"
                }
            }),
        );

        let state = runtime.state.lock().expect("runtime state");
        assert_eq!(
            state.provider_session_id.as_deref(),
            Some("conversation-123")
        );
        assert_eq!(state.phase, ChatPhase::Ready);
        let tools = state
            .replay
            .iter()
            .filter_map(|event| match event {
                ChatEvent::Tool {
                    id, status, output, ..
                } => Some((id, status, output)),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(tools.len(), 2);
        assert!(tools
            .iter()
            .all(|(id, ..)| id.as_str() == "antigravity-tool-1-3"));
        assert_eq!(tools[0].1, "running");
        assert_eq!(tools[1].1, "completed");
        assert_eq!(tools[1].2.as_deref(), Some("/workspace"));
        assert!(state.replay.iter().any(|event| matches!(
            event,
            ChatEvent::MessageDelta { role, delta, .. }
                if role == "assistant" && delta == "AGY_OK"
        )));
        assert!(state.replay.iter().any(|event| matches!(
            event,
            ChatEvent::Turn { status, .. } if status == "completed"
        )));
    }

    #[test]
    fn approval_decisions_match_codex_protocol() {
        assert_eq!(ChatApprovalDecision::Accept.codex_value(), "accept");
        assert_eq!(
            ChatApprovalDecision::AcceptForSession.codex_value(),
            "acceptForSession"
        );
        assert_eq!(ChatApprovalDecision::Decline.codex_value(), "decline");
    }

    #[test]
    fn ansi_sequences_are_removed_from_provider_logs() {
        assert_eq!(strip_ansi("\u{1b}[31mERROR\u{1b}[0m plain"), "ERROR plain");
    }

    #[test]
    fn empty_tool_input_is_not_rendered() {
        assert_eq!(meaningful_json(Some(&json!({}))), None);
        assert_eq!(pretty_json_text("{}"), None);
        assert_eq!(
            pretty_json_text(r#"{"path":"/tmp"}"#),
            Some("{\n  \"path\": \"/tmp\"\n}".to_owned())
        );
    }

    #[test]
    fn claude_tool_stream_uses_one_id_and_finishes_with_result() {
        let runtime = Arc::new(fixture_runtime(ProviderId::Claude));
        handle_anthropic_stream_event(
            &runtime,
            &json!({
                "type": "content_block_start",
                "index": 2,
                "content_block": {"type": "tool_use", "id": "tool-abc", "name": "Read", "input": {}}
            }),
        );
        handle_anthropic_stream_event(
            &runtime,
            &json!({
                "type": "content_block_delta",
                "index": 2,
                "delta": {"partial_json": "{\"file_path\":\"/tmp/a\"}"}
            }),
        );
        handle_anthropic_message_content(
            &runtime,
            Some(&json!([{
                "type": "tool_result",
                "tool_use_id": "tool-abc",
                "content": "file contents"
            }])),
            true,
        );

        let state = runtime.state.lock().expect("runtime state");
        let tools = state
            .replay
            .iter()
            .filter_map(|event| match event {
                ChatEvent::Tool {
                    id,
                    status,
                    detail,
                    output,
                    ..
                } => Some((id, status, detail, output)),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(tools.len(), 3);
        assert!(tools.iter().all(|(id, ..)| id.as_str() == "tool-abc"));
        assert_eq!(tools[0].2, &None);
        assert_eq!(tools[2].1, "completed");
        assert_eq!(tools[2].3.as_deref(), Some("file contents"));
        assert!(state.provider_tool_blocks.is_empty());
    }

    #[test]
    fn completed_assistant_output_is_persisted_as_a_supplement() {
        let directory = tempfile::tempdir().expect("temporary store");
        let mut runtime = fixture_runtime(ProviderId::Claude);
        runtime.app_data_dir = Some(directory.path().to_path_buf());
        let runtime = Arc::new(runtime);
        {
            let mut state = runtime.state.lock().expect("runtime state");
            state.provider_session_id = Some("session-1234567890".to_owned());
            state.active_turn_id = Some("turn-1234567890abcd".to_owned());
        }

        runtime.emit(ChatEvent::MessageDelta {
            id: "message-1234567890".to_owned(),
            role: "assistant".to_owned(),
            kind: "message".to_owned(),
            delta: "persisted response".to_owned(),
        });
        runtime.emit(ChatEvent::Turn {
            id: "turn-1234567890abcd".to_owned(),
            status: "completed".to_owned(),
            timestamp: 123,
        });

        let turns =
            store::captured_turns_for(directory.path(), ProviderId::Claude, "session-1234567890")
                .expect("captured turn");
        assert_eq!(turns.len(), 1);
        assert_eq!(turns[0].text, "persisted response");
        assert!(matches!(turns[0].origin, SupplementOrigin::Chat));
    }

    #[test]
    fn messages_sent_while_running_are_queued_in_order() {
        let runtime = Arc::new(fixture_runtime(ProviderId::Claude));
        runtime.state.lock().expect("runtime state").phase = ChatPhase::Running;
        runtime
            .send("first", &[], false, true)
            .expect("queue first");
        runtime
            .send("second", &[], false, true)
            .expect("queue second");

        let state = runtime.state.lock().expect("runtime state");
        assert_eq!(state.phase, ChatPhase::Running);
        assert_eq!(
            state
                .queue
                .iter()
                .map(|message| message.text.as_str())
                .collect::<Vec<_>>(),
            vec!["first", "second"]
        );
        assert!(state.replay.iter().any(|event| matches!(
            event,
            ChatEvent::Queue { items } if items.len() == 2
        )));
    }

    #[test]
    fn managed_send_does_not_implicitly_queue_while_running() {
        let runtime = Arc::new(fixture_runtime(ProviderId::Claude));
        runtime.state.lock().expect("runtime state").phase = ChatPhase::Running;

        let error = runtime
            .send("must not queue", &[], false, false)
            .expect_err("running chat must reject immediate delivery");

        assert!(matches!(error, CoreError::Conflict(_)));
        assert!(runtime
            .state
            .lock()
            .expect("runtime state")
            .queue
            .is_empty());
    }

    #[test]
    fn steering_message_jumps_to_queue_front() {
        let runtime = Arc::new(fixture_runtime(ProviderId::Claude));
        runtime.state.lock().expect("runtime state").phase = ChatPhase::Running;
        runtime
            .send("first", &[], false, true)
            .expect("queue first");
        // 활성 자식 프로세스가 없어 interrupt는 실패하지만 메시지는 맨 앞에 남아야 한다.
        runtime
            .send("urgent", &[], true, true)
            .expect("steer message");

        let state = runtime.state.lock().expect("runtime state");
        assert_eq!(
            state
                .queue
                .iter()
                .map(|message| message.text.as_str())
                .collect::<Vec<_>>(),
            vec!["urgent", "first"]
        );
    }

    #[test]
    fn removing_a_queued_message_updates_the_queue() {
        let runtime = Arc::new(fixture_runtime(ProviderId::Claude));
        runtime.state.lock().expect("runtime state").phase = ChatPhase::Running;
        runtime
            .send("first", &[], false, true)
            .expect("queue first");
        runtime
            .send("second", &[], false, true)
            .expect("queue second");
        let first_id = runtime.state.lock().expect("runtime state").queue[0]
            .id
            .clone();

        runtime.remove_queued(&first_id).expect("remove queued");

        let state = runtime.state.lock().expect("runtime state");
        assert_eq!(state.queue.len(), 1);
        assert_eq!(state.queue[0].text, "second");
        assert!(state.replay.iter().any(|event| matches!(
            event,
            ChatEvent::Queue { items } if items.len() == 1 && items[0].text == "second"
        )));
    }

    #[test]
    fn queued_message_returns_to_front_when_turn_start_fails() {
        // 픽스처 실행 파일(/cli)은 실행할 수 없어 드레인된 턴 시작이 실패한다.
        let runtime = Arc::new(fixture_runtime(ProviderId::Claude));
        runtime.state.lock().expect("runtime state").phase = ChatPhase::Running;
        runtime
            .send("queued", &[], false, true)
            .expect("queue message");
        runtime.state.lock().expect("runtime state").phase = ChatPhase::Ready;

        runtime.drain_queue();

        let state = runtime.state.lock().expect("runtime state");
        assert_eq!(state.phase, ChatPhase::Ready);
        assert_eq!(state.queue.len(), 1);
        assert_eq!(state.queue[0].text, "queued");
        assert!(state.replay.iter().any(|event| matches!(
            event,
            ChatEvent::Turn { status, .. } if status == "failed"
        )));
    }

    #[test]
    fn stopping_a_chat_clears_the_queue() {
        let runtime = Arc::new(fixture_runtime(ProviderId::Claude));
        runtime.state.lock().expect("runtime state").phase = ChatPhase::Running;
        runtime
            .send("pending", &[], false, true)
            .expect("queue message");

        runtime.stop().expect("stop runtime");

        let state = runtime.state.lock().expect("runtime state");
        assert_eq!(state.phase, ChatPhase::Stopped);
        assert!(state.queue.is_empty());
        assert!(state.replay.iter().any(|event| matches!(
            event,
            ChatEvent::Queue { items } if items.is_empty()
        )));
    }

    #[test]
    fn resumed_chat_reports_the_selected_request_mode() {
        let mut runtime = fixture_runtime_with_mode(ProviderId::Codex, ChatMode::FullAccess);
        runtime.resuming = true;
        let mut state = runtime.state.lock().expect("runtime state");
        state.provider_session_id = Some("019fe900-5871-7161-a20c-4c1f23605ec4".to_owned());
        let info = runtime.info_from(&state);

        assert_eq!(info.mode, ChatMode::FullAccess);
        assert!(info.resuming);
        assert_eq!(
            info.provider_session_id.as_deref(),
            Some("019fe900-5871-7161-a20c-4c1f23605ec4")
        );
    }

    #[test]
    fn codex_resume_excludes_historical_turns_from_the_startup_rpc() {
        let mut runtime = fixture_runtime(ProviderId::Codex);
        let (start_method, start_params) =
            codex_thread_request(&runtime, json!({"cwd": "/workspace"}))
                .expect("new thread request");
        assert_eq!(start_method, "thread/start");
        assert!(start_params.get("excludeTurns").is_none());

        runtime.resuming = true;
        runtime
            .state
            .lock()
            .expect("runtime state")
            .provider_session_id = Some("thread-123".to_owned());
        let (resume_method, resume_params) =
            codex_thread_request(&runtime, json!({"cwd": "/workspace"}))
                .expect("resume thread request");
        assert_eq!(resume_method, "thread/resume");
        assert_eq!(resume_params["threadId"], "thread-123");
        assert_eq!(resume_params["excludeTurns"], true);
    }

    fn fixture_runtime(source: ProviderId) -> ChatRuntime {
        fixture_runtime_with_mode(source, ChatMode::Workspace)
    }

    fn fixture_runtime_with_mode(source: ProviderId, mode: ChatMode) -> ChatRuntime {
        ChatRuntime {
            chat_id: "chat".to_owned(),
            started_at: 0,
            source,
            account_id: None,
            cwd: Path::new("/").to_path_buf(),
            executable: Path::new("/cli").to_path_buf(),
            model: None,
            reasoning_effort: None,
            mode,
            approval_mode: ChatApprovalMode::default().for_provider(source),
            resuming: false,
            unattended: false,
            profile: ChatProfile::Standard,
            dynamic_settings: BTreeMap::new(),
            session_catalog: None,
            system_mcp_url: None,
            capture_id: None,
            app_data_dir: None,
            attention: Arc::new(ChatAttentionStore::default()),
            accounts: None,
            state: Mutex::new(RuntimeState {
                phase: ChatPhase::Ready,
                provider_session_id: None,
                current_turn_id: None,
                active_turn_id: None,
                turn_count: 0,
                last_turn_status: None,
                next_request_id: 3,
                pending_approvals: HashMap::new(),
                provider_tool_blocks: HashMap::new(),
                subscriber: None,
                subscriber_generation: 0,
                replay: VecDeque::new(),
                assistant_output: String::new(),
                queue: VecDeque::new(),
                uploads: HashMap::new(),
                claude_interrupt_pending: false,
            }),
            stdin: Mutex::new(None),
            child: Mutex::new(None),
            account_runtime_lease: Mutex::new(None),
        }
    }

    fn aia_runtime(source: ProviderId, mcp_url: Option<&str>) -> ChatRuntime {
        let mut runtime = fixture_runtime(source);
        runtime.profile = ChatProfile::Aia;
        runtime.system_mcp_url = mcp_url.map(str::to_owned);
        runtime
    }

    #[test]
    fn aia_on_claude_attaches_only_the_system_mcp_interface() {
        let runtime = aia_runtime(ProviderId::Claude, Some("http://127.0.0.1:4178/mcp/key"));
        let args = claude_stream_cli_args(&runtime, false);

        let config = args
            .iter()
            .position(|argument| argument == "--mcp-config")
            .expect("--mcp-config");
        let payload: Value =
            serde_json::from_str(&args[config + 1]).expect("the MCP config must be valid JSON");
        assert_eq!(
            payload
                .pointer("/mcpServers/aia_system/url")
                .and_then(Value::as_str),
            Some("http://127.0.0.1:4178/mcp/key")
        );
        // `--mcp-config`는 값이 여러 개인 가변 옵션이라 뒤에 플래그가 와야 JSON만 소비된다.
        assert!(
            args[config + 2].starts_with("--"),
            "a flag must follow the MCP config payload"
        );
        assert!(args
            .iter()
            .any(|argument| argument == "--strict-mcp-config"));
        assert!(args
            .iter()
            .any(|argument| argument == "--append-system-prompt"));
        assert!(args
            .iter()
            .any(|argument| argument.contains("당신의 이름은 AIA")));
    }

    #[test]
    fn standard_claude_chats_keep_the_users_own_mcp_configuration() {
        let runtime = fixture_runtime(ProviderId::Claude);
        let args = claude_stream_cli_args(&runtime, false);
        assert!(!args.iter().any(|argument| argument == "--mcp-config"));
        assert!(!args
            .iter()
            .any(|argument| argument == "--strict-mcp-config"));
        assert!(!args
            .iter()
            .any(|argument| argument == "--append-system-prompt"));
    }

    #[test]
    fn aia_on_antigravity_carries_its_instructions_in_the_first_prompt_only() {
        let runtime = aia_runtime(ProviderId::Antigravity, None);
        let first = antigravity_stream_cli_args(&runtime, "상태 알려줘", None);
        let prompt = &first[first
            .iter()
            .position(|argument| argument == "--print")
            .expect("--print")
            + 1];
        assert!(prompt.contains("당신의 이름은 AIA"));
        assert!(prompt.ends_with("상태 알려줘"));

        // 대화가 이어진 뒤에는 지침을 다시 붙이지 않는다.
        let next = antigravity_stream_cli_args(&runtime, "다음 질문", Some("conversation-1"));
        let followup = &next[next
            .iter()
            .position(|argument| argument == "--print")
            .expect("--print")
            + 1];
        assert_eq!(followup, "다음 질문");
    }

    #[test]
    fn antigravity_cannot_expose_the_aia_system_interface() {
        assert!(provider_supports_aia_system_mcp(ProviderId::Codex));
        assert!(provider_supports_aia_system_mcp(ProviderId::Claude));
        assert!(!provider_supports_aia_system_mcp(ProviderId::Antigravity));
    }

    #[test]
    fn resuming_an_aia_workspace_session_keeps_the_profile_on_every_provider() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let app_data_dir = directory.path().to_path_buf();
        let workspace = app_data_dir.join("aia-workspace");
        fs::create_dir_all(&workspace).expect("aia workspace");
        let other = app_data_dir.join("project");
        fs::create_dir_all(&other).expect("project directory");

        for source in [
            ProviderId::Codex,
            ProviderId::Claude,
            ProviderId::Antigravity,
        ] {
            let mut request = fixture_start_request(source, &workspace);
            request.resume_session_id = Some("session-1".to_owned());
            assert_eq!(
                effective_chat_profile(&request, Some(&app_data_dir)).expect("profile"),
                ChatProfile::Aia,
                "{source:?} must keep the AIA profile when resuming the AIA workspace"
            );

            let mut project = fixture_start_request(source, &other);
            project.resume_session_id = Some("session-1".to_owned());
            assert_eq!(
                effective_chat_profile(&project, Some(&app_data_dir)).expect("profile"),
                ChatProfile::Standard,
                "{source:?} project sessions stay standard"
            );
        }
    }

    #[test]
    fn the_aia_provider_follows_the_selected_system_agent() {
        let mut settings = crate::domain::SystemAutomationSettings::default();
        // 시스템 에이전트를 고르지 않으면 AIA도 쓸 수 없다.
        assert_eq!(settings.aia_provider(), None);
        settings.system_provider = Some(ProviderId::Claude);
        assert_eq!(settings.aia_provider(), Some(ProviderId::Claude));
        settings.system_provider = Some(ProviderId::Codex);
        assert_eq!(settings.aia_provider(), Some(ProviderId::Codex));
        // 시스템 에이전트가 될 수 없는 값이 남아 있으면 고르지 않은 것과 같다.
        settings.system_provider = Some(ProviderId::Antigravity);
        assert_eq!(settings.aia_provider(), None);
    }

    #[test]
    fn only_runtimes_with_per_run_mcp_config_can_be_system_agents() {
        assert!(ProviderId::Codex.can_run_system_agent());
        assert!(ProviderId::Claude.can_run_system_agent());
        assert!(!ProviderId::Antigravity.can_run_system_agent());
    }

    fn fixture_start_request(source: ProviderId, cwd: &Path) -> ChatStartRequest {
        ChatStartRequest {
            source,
            cwd: cwd.to_string_lossy().into_owned(),
            model: None,
            reasoning_effort: None,
            mode: ChatMode::Workspace,
            approval_mode: ChatApprovalMode::default(),
            resume_session_id: None,
            unattended: false,
            profile: ChatProfile::Standard,
            account_id: None,
            account_transition_id: None,
            capture_id: None,
            settings: BTreeMap::new(),
            startup_cancel: None,
        }
    }

    fn session_with_project(id: &str, cwd: &Path, hidden: bool) -> SessionSummary {
        SessionSummary {
            source: ProviderId::Codex,
            id: id.to_owned(),
            title: id.to_owned(),
            source_title: Some(id.to_owned()),
            project: cwd
                .file_name()
                .map(|name| name.to_string_lossy().into_owned()),
            cwd: Some(cwd.to_string_lossy().into_owned()),
            started_at: None,
            updated_at: None,
            message_count: None,
            token_total: None,
            token_usage: None,
            model: None,
            git_branch: None,
            is_subagent: false,
            archived: false,
            readable: true,
            size_bytes: None,
            file_path: String::new(),
            meta: crate::domain::SessionMeta {
                hidden,
                ..crate::domain::SessionMeta::default()
            },
        }
    }
}
