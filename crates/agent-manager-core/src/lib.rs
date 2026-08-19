#![recursion_limit = "256"]

mod accounts;
mod backend_ownership;
mod backend_service_settings;
mod catalog;
mod chat;
mod domain;
mod external_processes;
mod linked_file;
mod mcp_registry;
mod providers;
mod remote;
mod scheduler;
mod session_management;
mod storage_reset;
mod store;
mod system_mcp;
mod system_workflows;
mod terminal;
mod translation;

pub(crate) use accounts::migrate_legacy_macos_credential_vault;

pub use accounts::{
    AccountAuthStatus, AccountLoginSessionView, AccountRuntimeLease, AccountSnapshot,
    AccountSupervisor, AccountTransitionGuard, AccountUsageStatus, AccountUsageView,
    AccountUsageWindow, AutoSwitchEventView, AutoSwitchReason, AutoSwitchSignal,
    ProviderAccountStateView, ProviderAccountTransitionRecovery, ProviderAccountTransitionView,
    ProviderAccountView,
};
pub use backend_ownership::BackendOwnershipLease;
pub use backend_service_settings::{
    load_backend_service_settings, save_backend_service_settings, BackendServiceSettings,
    DEFAULT_BACKEND_SERVICE_PORT, MAX_BACKEND_SERVICE_PORT, MIN_BACKEND_SERVICE_PORT,
};
pub use catalog::{
    load_agent_detail, load_artifact_detail, load_manager_snapshot, load_session_detail,
    load_session_detail_with_limit, load_session_summary, load_session_transcript_before,
    load_skill_detail, load_storage_overview, SessionCatalog,
};
pub use chat::{
    load_chat_provider_options, provider_session_app_url, provider_supports_aia_system_mcp,
    ChatApprovalDecision, ChatApprovalMode, ChatAttachment, ChatAttentionItem, ChatAttentionKind,
    ChatAttentionSnapshot, ChatDeliveryStatus, ChatEvent, ChatInputFile, ChatInputFileDownload,
    ChatInputFileKind, ChatMessageDelivery, ChatMode, ChatModelOption, ChatPhase, ChatProfile,
    ChatProviderOptions, ChatReasoningOption, ChatSessionInfo, ChatSettingField,
    ChatSettingFieldKind, ChatSettingOption, ChatStartRequest, ChatSupervisor, ReasoningEffort,
    StopChatFailure, StopChatReceipt, StopProviderChatsReport, MAX_CHAT_INPUT_FILES,
    MAX_CHAT_INPUT_FILE_BYTES, MAX_CHAT_INPUT_IMAGE_BYTES,
};
pub use domain::{
    AgentDefinition, AgentDetail, AppStatus, ArtifactDetail, ArtifactGroup, ArtifactSummary,
    ContentBlock, DashboardStats, DetectedResource, DocFile, DocRootStatus, FileNode,
    ManagerSnapshot, MenuTranslations, ProviderId, ProviderStatus, SessionCatalogUpdate,
    SessionDetail, SessionFolder, SessionMeta, SessionMetaPatch, SessionSummary,
    SessionTranscriptLimit, SkillDetail, SkillSummary, StorageOverview, StorageUsageItem,
    SupplementStorageStats, SystemAutomationSettings, SystemAutomationSettingsInput,
    SystemAutomationSnapshot, SystemLanguageRequest, TokenUsage, TranscriptItem, TranslatedDetail,
    TranslationLanguage, TranslationMenu, TranslationMenuSettings, TranslationStatus,
    TranslationSummary, UiTranslationCatalogInput,
};
pub use external_processes::{
    list_external_provider_processes, terminate_external_provider_processes,
    ExternalProcessFailure, ExternalProviderProcess, TerminateExternalProcessesReport,
};
pub use linked_file::{save_linked_file_download, LinkedFile, LinkedFileDownload};
pub use providers::inspect_local_environment;
pub use remote::{
    load_tailscale_backend_launch, run_remote_server_from_args, RemoteAccessPhase,
    RemoteAccessSettingsInput, RemoteAccessStatus, RemoteAccessSupervisor, TailscaleBackendLaunch,
};
pub use scheduler::{
    CancelAndRecoverScheduledRunReceipt, ProviderTransitionRecoveryReceipt,
    ProviderTransitionRecoveryRequest, ResumeFailurePolicy, ScheduleFrequency, ScheduleRecurrence,
    ScheduleRun, ScheduleRunStatus, ScheduleSessionStrategy, ScheduledRequest,
    ScheduledRequestInput, ScheduledRunCancellationReceipt, SchedulerAttachment, SchedulerEvent,
    SchedulerSnapshot, SchedulerSupervisor,
};
pub use session_management::{
    append_system_audit, get_chat_delivery_status, get_scheduled_request_detail,
    get_scheduled_run_detail, get_session_statistics, get_session_transcript_page,
    list_scheduled_requests, list_scheduled_runs, list_sessions, list_system_audit,
    send_chat_message, start_chat, switch_active_provider_account, ChatDeliveryLookup,
    ManagedSessionSummary, ManagedTranscriptItem, ProviderSessionStatistics,
    ScheduleRunDetailResponse, ScheduleRunListRequest, ScheduleRunListResponse, ScheduleRunSummary,
    ScheduledRequestListRequest, ScheduledRequestListResponse, ScheduledRequestSummary,
    SendChatMessageRequest, SessionAppliedFilters, SessionListRequest, SessionListResponse,
    SessionManagementStatus, SessionSortField, SessionStatisticsRequest, SessionStatisticsResponse,
    SessionStatisticsTotals, SessionTranscriptPageRequest, SessionTranscriptPageResponse,
    SortDirection, StartChatDelivery, StartChatRequest, SwitchActiveProviderAccountReceipt,
    SwitchActiveProviderAccountRequest, SystemAuditListRequest, SystemAuditListResponse,
    SystemAuditPhase, SystemAuditRecord, TranscriptAppliedFilters, TranscriptCategory,
};
pub use storage_reset::prepare_account_management_storage;
pub use store::{
    add_doc_root, create_session_folder, delete_session_folder, list_doc_roots, list_doc_tree,
    list_session_folders, read_doc, read_doc_linked_file, read_doc_linked_file_download,
    remove_doc_root, save_doc, update_session_folder, update_session_meta,
};
pub use system_mcp::SystemMcpServer;
pub use terminal::{
    StopProviderTerminalsReport, StopTerminalFailure, TerminalAccountLoginRequest,
    TerminalAttachment, TerminalEvent, TerminalOpenRequest, TerminalPhase, TerminalSessionInfo,
    TerminalSetupRequest, TerminalSupervisor,
};
pub use translation::TranslationSupervisor;

#[derive(Debug, thiserror::Error)]
pub enum CoreError {
    #[error("사용자 홈 디렉터리를 확인할 수 없습니다")]
    HomeDirectoryUnavailable,
    #[error("파일 처리 중 오류가 발생했습니다: {0}")]
    Io(#[from] std::io::Error),
    #[error("JSON 데이터를 읽지 못했습니다: {0}")]
    Json(#[from] serde_json::Error),
    #[error("SQLite 데이터를 읽지 못했습니다: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("{0}")]
    InvalidInput(String),
    #[error("{0}")]
    NotFound(String),
    #[error("{0}")]
    Conflict(String),
    #[error("{0}")]
    ResumeFailed(String),
    #[error("파일이 너무 큽니다. 최대 {0}바이트까지 허용됩니다")]
    TooLarge(u64),
    #[error("{0}")]
    Runtime(String),
}
