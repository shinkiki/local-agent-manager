#![recursion_limit = "512"]

mod account_tools;
mod accounts;
mod aia_suggestions;
mod antigravity_usage;
mod app_data_file;
mod backend_ownership;
mod backend_service_settings;
mod catalog;
mod catalog_health;
mod chat;
mod chat_runtime_store;
mod chat_settings;
mod claude_settings;
mod cli_interface;
mod cli_updates;
mod clock;
mod credential_profiles;
mod cypress_runs;
mod cypress_workspaces;
mod document_automation;
mod document_tree;
mod domain;
mod external_plugins;
mod external_processes;
mod file_kind;
mod identifier;
mod instruction_links;
mod instruction_trash;
mod json_store;
mod linked_file;
mod loopback_host;
mod markdown_plain;
mod mcp_registry;
mod path_guard;
mod power;
mod process_output;
#[cfg(unix)]
mod process_signal;
mod project_instructions;
mod project_registry;
mod providers;
mod quiet_hours;
mod remote;
mod resource_repository;
mod scheduler;
mod session_context;
mod session_folders;
mod session_management;
mod skill_library;
mod skill_meta;
mod skill_trash;
mod ssh_endpoints;
mod ssh_keys;
mod staged_replace;
mod storage_reset;
mod store;
mod store_lock;
mod system_mcp;
mod system_skills;
mod system_workflows;
mod terminal;
mod text_limit;
mod translation;
mod trash_store;
mod usage_budget;
mod usage_budget_policy;
mod usage_history;
mod usage_pacing;
mod user_home;
mod user_path;

pub(crate) use accounts::{migrate_legacy_macos_credential_vault, UnscopedRuntimeKind};

pub use account_tools::{
    list_account_tools, AccountToolAccess, AccountToolAttribution, AccountToolKind,
    AccountToolView, AccountToolsSnapshot, AccountToolsView, ProviderHomeToolsView,
};
pub use accounts::{
    AccountAuthStatus, AccountLoginSessionView, AccountRuntimeLease, AccountSnapshot,
    AccountSupervisor, AccountUsageStatus, AccountUsageView, AccountUsageWindow,
    AutoSwitchEventView, AutoSwitchPolicy, AutoSwitchReason, AutoSwitchSignal, HomeCredentialState,
    ProviderAccountStateView, ProviderAccountView, ProviderHomeView, ResumeAccountPolicy,
    RunReadiness, ACCOUNT_NOTE_MAX_CHARS,
};
pub use aia_suggestions::{
    load_aia_suggestion_catalog, AiaSuggestionBundledSkillTemplate, AiaSuggestionCatalog,
    AiaSuggestionCatalogDefinition, AiaSuggestionCatalogIssue, AiaSuggestionDefinition,
    AiaSuggestionEffectivePack, AiaSuggestionKind, AiaSuggestionPack, AiaSuggestionPackSource,
    AiaSuggestionParameterValue, AiaSuggestionRearm, AiaSuggestionSeverity,
    AiaSuggestionTemplateFile,
};
pub use antigravity_usage::{antigravity_usage, antigravity_usage_cached_first};
pub use backend_ownership::BackendOwnershipLease;
pub use backend_service_settings::{
    load_backend_service_settings, save_backend_service_remote_write,
    save_backend_service_settings, BackendServiceSettings, DEFAULT_BACKEND_REMOTE_WRITE,
    DEFAULT_BACKEND_SERVICE_PORT, MAX_BACKEND_SERVICE_PORT, MIN_BACKEND_SERVICE_PORT,
};
pub use catalog::{
    load_agent_detail, load_artifact_detail, load_manager_snapshot, load_session_detail,
    load_session_detail_with_limit, load_session_summary, load_session_transcript_before,
    load_session_transcript_image, load_skill_detail, load_storage_overview, SessionCatalog,
    TranscriptImage,
};
pub use catalog_health::{health as catalog_health, CatalogHealth, DegradedScan, ScanKind};
pub use chat::{
    provider_session_app_url, provider_supports_aia_system_mcp, ChatApprovalDecision,
    ChatApprovalMode, ChatAttachment, ChatAttentionItem, ChatAttentionKind, ChatAttentionPreview,
    ChatAttentionSnapshot, ChatDeliveryStatus, ChatEvent, ChatInputFile, ChatInputFileDownload,
    ChatInputFileKind, ChatMessageDelivery, ChatMode, ChatModelOption, ChatPhase, ChatProfile,
    ChatProviderOptions, ChatReasoningOption, ChatRejectionCode, ChatSessionInfo, ChatSettingField,
    ChatSettingFieldKind, ChatSettingOption, ChatStartRequest, ChatSupervisor, ReasoningEffort,
    StopChatFailure, StopChatReceipt, StopProviderChatsReport, MAX_CHAT_INPUT_FILES,
    MAX_CHAT_INPUT_FILE_BYTES, MAX_CHAT_INPUT_IMAGE_BYTES,
};
pub use chat_settings::load_chat_provider_options;
pub use claude_settings::{
    load_claude_settings_states, set_claude_plugin_enabled, set_claude_skill_override,
    ClaudePluginSettingValue, ClaudePluginState, ClaudeScopeValues, ClaudeSettingsFileStatus,
    ClaudeSettingsScopeKind, ClaudeSettingsScopes, ClaudeSettingsSnapshot,
    ClaudeSettingsWriteScope, ClaudeSkillOverrideState, SetClaudePluginEnabledRequest,
    SetClaudeSkillOverrideRequest, SkillOverrideValue,
};
pub use cli_updates::{
    check_provider_cli_update, clear_provider_model_caches, list_provider_cli_update_status,
    provider_cli_update_status, provider_runtime_counts, update_provider_cli, CliInstallSource,
    CliUpdateMethod, CliUpdateOutcome, CliUpdateReceipt, ModelCacheCleanupEntry,
    ModelCacheCleanupReceipt, ModelCacheState, ModelCacheStatus, ProviderCliUpdateStatus,
    ProviderRuntimeCounts, ProviderRuntimeStopSummary,
};
pub use document_automation::{
    DocumentActionContext, DocumentActionError, DocumentActionErrorKind, DocumentActionExecutor,
    DocumentActionOption, DocumentActionReceipt, DocumentAutomationOptions,
    DocumentAutomationSnapshot, DocumentAutomationSupervisor, DocumentChange, DocumentChangeBatch,
    DocumentChangeKind, DocumentChatAction, DocumentOfflineChangeReport, DocumentSkillBinding,
    DocumentTrigger, DocumentTriggerAction, DocumentTriggerInput, DocumentTriggerRun,
    DocumentTriggerRunStatus, DocumentTriggerStatus, DocumentWorkflowAction,
};
pub use domain::{
    AgentDefinition, AgentDetail, AiaDecisionPolicy, AppStatus, ArtifactDetail, ArtifactGroup,
    ArtifactSummary, CommonSkillDetail, CommonSkillDigest, CommonSkillSource, ContentBlock,
    DashboardStats, DetectedResource, DocFile, DocRootStatus, DocumentEntry, DocumentEntryPage,
    DocumentFile, DocumentPreviewKind, FileNode, ManagerSnapshot, MenuTranslations,
    ProjectRegistryEntry, ProviderId, ProviderStatus, SessionCatalogUpdate, SessionDetail,
    SessionFailureKind, SessionFolder, SessionLastFailure, SessionLink, SessionMeta,
    SessionMetaPatch, SessionRuntimeFailure, SessionSummary, SessionTranscriptLimit,
    SkillAdapterRootView, SkillAdapterView, SkillDetail, SkillLibrary, SkillLibraryEntry,
    SkillLibraryIssue, SkillOriginKind, SkillProviderState, SkillProviderStatus, SkillSummary,
    StorageOverview, StorageUsageItem, SupplementStorageStats, SystemAgentRuntime,
    SystemAutomationSettings, SystemAutomationSettingsInput, SystemAutomationSnapshot,
    SystemLanguageRequest, TokenUsage, TranscriptImageBlock, TranscriptItem, TranslatedDetail,
    TranslationLanguage, TranslationMenu, TranslationMenuSettings, TranslationStatus,
    TranslationSummary, UiTranslationCatalogInput,
};
pub use external_plugins::{
    ExternalPluginIdRequest, ExternalPluginOAuthStart, ExternalPluginRegistry,
    ExternalPluginToolCallRequest, ExternalPluginView, ExternalPluginsSnapshot, PluginAuthKind,
    PluginToolPolicy, RegisterExternalPluginRequest, SetExternalPluginEnabledRequest,
    SetExternalPluginTokenRequest, SetExternalPluginToolPoliciesRequest,
    SetExternalPluginToolPolicyRequest, UpdateExternalPluginRequest,
};
pub use external_processes::{
    list_external_provider_processes, terminate_external_provider_processes,
    ExternalProcessFailure, ExternalProviderProcess, TerminateExternalProcessesReport,
};
pub use instruction_trash::{
    list_instruction_trash, purge_instruction_trash, restore_instruction_trash,
    InstructionTrashItem, InstructionTrashItemKind, InstructionTrashOverview,
    InstructionTrashRestoreReceipt,
};
pub use linked_file::{save_linked_file_download, LinkedFile, LinkedFileDownload};
pub use power::{
    apply_saved_sleep_prevention, release_sleep_prevention, set_sleep_prevention,
    sleep_prevention_status, SleepPreventionStatus,
};
pub use project_instructions::{
    attach_project_instruction_deployment, check_project_instruction_delete,
    create_project_instruction, delete_project_instruction_deployment,
    delete_shared_project_instruction, detach_project_instruction_deployment,
    get_project_instruction_migration_plan, import_project_instruction,
    load_project_instruction_library, preview_project_instruction_import,
    publish_project_instruction, read_deployed_instruction_file,
    read_deployed_instruction_linked_file, read_deployed_instruction_linked_file_download,
    read_project_instruction_file, save_project_instruction_platform_variant,
    set_project_instruction_auto_sync, set_project_instruction_platforms,
    sync_project_instruction_from_deployment, unarchive_shared_project_instruction,
    update_project_instruction, CreateProjectInstructionRequest,
    DeleteProjectInstructionDeploymentRequest, DeleteSharedProjectInstructionRequest,
    DeployedInstructionFileContent, DeployedInstructionLinkedFileRequest,
    ImportProjectInstructionRequest, InstructionDeleteCheckRequest, InstructionDeleteImpact,
    InstructionDeleteReceipt, InstructionDeploymentLinkRequest, InstructionImportLinkedDoc,
    InstructionImportPreview, InstructionImportPreviewRequest, InstructionLinkIssue,
    InstructionLinkedFileResult, InstructionProviderFileWrite, InstructionPublishOutcome,
    InstructionPublishReceipt, InstructionSyncReceipt, InstructionUpdateReceipt,
    ProjectInstructionDeployment, ProjectInstructionEntry, ProjectInstructionFileContent,
    ProjectInstructionIssue, ProjectInstructionLibrary, ProjectInstructionMigrationPlan,
    PublishProjectInstructionRequest, ReadDeployedInstructionFileRequest,
    SaveProjectInstructionPlatformVariantRequest, SetProjectInstructionPlatformsRequest,
    SyncProjectInstructionRequest, UnarchiveSharedProjectInstructionRequest,
    UpdateProjectInstructionRequest,
};
pub use providers::inspect_local_environment;
pub use remote::{
    load_tailscale_backend_launch, run_remote_server_from_args, RemoteAccessPhase,
    RemoteAccessSettingsInput, RemoteAccessStatus, RemoteAccessSupervisor, TailscaleBackendLaunch,
};
pub use resource_repository::{
    load_resource_repository_settings, set_resource_repository, HostPlatform,
    ResourcePlatformManifest, ResourceRepositorySettings, SetResourceRepositoryRequest,
};
pub use scheduler::{
    ResumeFailurePolicy, ScheduleFrequency, ScheduleRecurrence, ScheduleRun, ScheduleRunRound,
    ScheduleRunStatus, ScheduleSessionStrategy, ScheduleWorkflowAction, ScheduleWorkflowExecutor,
    ScheduledDocumentTriggerContext, ScheduledRequest, ScheduledRequestInput,
    ScheduledRunCancellationReceipt, SchedulerAttachment, SchedulerEvent, SchedulerHandle,
    SchedulerSnapshot, SchedulerSupervisor,
};
pub use session_context::{
    describe_policy as describe_session_read_policy,
    normalize_policy as normalize_session_read_policy,
    reconcile_settings as reconcile_session_read_settings, recurrence_span_ms,
    redact as redact_session_text, resolve_policy as resolve_session_read_policy,
    resolve_run_session_read, resolve_window as resolve_session_read_window, untrusted_block,
    ResolvedSessionRead, ScheduleRunSessionRead, SessionReadActor, SessionReadDetail,
    SessionReadOrigin, SessionReadPeriod, SessionReadPolicy, SessionReadProjectScope,
    SessionReadRedaction, SessionReadRelativeUnit, SessionReadSettings, MAX_SESSION_READ_PAGE_SIZE,
    MAX_SESSION_READ_PROJECTS, MAX_SESSION_READ_RECENT_DAYS, MAX_SESSION_READ_RELATIVE_COUNT,
    MAX_SESSION_READ_SESSIONS, MAX_SESSION_READ_TURNS,
};
pub use session_management::{
    append_session_context_audit, append_system_audit, get_chat_delivery_status,
    get_scheduled_request_detail, get_scheduled_run_detail, get_session_statistics,
    get_session_transcript_page, list_scheduled_requests, list_scheduled_runs, list_sessions,
    list_system_audit, send_chat_message, start_chat, switch_active_provider_account,
    ChatDeliveryLookup, ManagedSessionSummary, ManagedTranscriptItem, ProviderSessionStatistics,
    ScheduleRunDetailResponse, ScheduleRunListRequest, ScheduleRunListResponse, ScheduleRunSummary,
    ScheduledRequestListRequest, ScheduledRequestListResponse, ScheduledRequestSummary,
    SendChatMessageRequest, SessionAppliedFilters, SessionListRequest, SessionListResponse,
    SessionManagementStatus, SessionSortField, SessionStatisticsRequest, SessionStatisticsResponse,
    SessionStatisticsTotals, SessionTranscriptPageRequest, SessionTranscriptPageResponse,
    SortDirection, StartChatDelivery, StartChatRequest, SwitchActiveProviderAccountReceipt,
    SwitchActiveProviderAccountRequest, SystemAuditListRequest, SystemAuditListResponse,
    SystemAuditPhase, SystemAuditRecord, TranscriptAppliedFilters, TranscriptCategory,
};
pub use skill_library::{
    check_skill_delete, check_skill_publish, compare_skill_install, create_common_skill,
    delete_installed_skill, delete_shared_skill, get_skill_migration_plan, import_skill_to_common,
    load_common_skill_detail, load_common_skill_digests, load_skill_library,
    load_skill_library_for_projects, publish_common_skill, read_common_skill_file,
    save_skill_platform_variant, set_skill_platforms, sync_skill_from_install,
    unarchive_shared_skill, update_common_skill, CompareSkillRequest, CreateCommonSkillRequest,
    DeleteInstalledSkillRequest, DeleteSharedSkillRequest, ImportCommonSkillRequest,
    SaveSkillPlatformVariantRequest, SetSkillPlatformsRequest, SkillCompatibilityIssue,
    SkillCompatibilityReport, SkillDeleteCheckRequest, SkillDeleteImpact, SkillDeleteImpactItem,
    SkillDeleteReceipt, SkillFileChange, SkillFileChangeStatus, SkillFileContent, SkillFileWrite,
    SkillInstallComparison, SkillIssueSeverity, SkillLocation, SkillMigrationPlan,
    SkillOverwritePolicy, SkillProviderCompatibility, SkillPublishOutcome, SkillPublishReceipt,
    SkillPublishRequest, SkillPublishResult, SkillSyncReceipt, SkillUpdateReceipt,
    SyncSkillRequest, UnarchiveSharedSkillRequest, UpdateCommonSkillRequest,
};
pub use skill_meta::set_skill_auto_sync;
pub use skill_trash::{
    list_skill_trash, purge_skill_trash, restore_skill_trash, SkillTrashItem, SkillTrashItemKind,
    SkillTrashOverview, SkillTrashRestoreOutcome, SkillTrashRestoreReceipt,
    SkillTrashRestoreResult,
};
pub use ssh_endpoints::{
    check_ssh_endpoint, command_policy_defaults, list_agent_ssh_endpoints, run_ssh_endpoint_cli,
    set_ssh_key_endpoint, AgentSshEndpointSkip, AgentSshEndpointView, AgentSshEndpointsView,
    SetSshKeyEndpointRequest, SshCommandPolicyDefaults, SshCommandPolicyMode,
    SshEndpointCheckReceipt, SshEndpointView,
};
pub use ssh_keys::{
    delete_ssh_key, generate_ssh_key, get_ssh_keys, read_ssh_public_key, set_ssh_key_note,
    GenerateSshKeyRequest, SetSshKeyNoteRequest, SshKeyDeletionReceipt, SshKeyIssue, SshKeyRef,
    SshKeyView, SshKeysSnapshot, SshPublicKeyView,
};
pub use storage_reset::prepare_account_management_storage;
pub use store::{
    add_doc_root, create_session_folder, delete_session_folder, list_doc_roots, list_doc_tree,
    list_document_entries, list_session_folders, read_doc, read_doc_linked_file,
    read_doc_linked_file_download, read_document_file, read_document_file_download,
    remove_doc_root, reorder_session_folder, save_doc, search_document_entries, set_project_active,
    update_session_folder, update_session_meta, FolderMoveDirection, MAX_SESSION_FOLDER_DEPTH,
};
pub use system_mcp::SystemMcpServer;
pub use terminal::{
    StopProviderTerminalsReport, StopTerminalFailure, TerminalAccountLoginRequest,
    TerminalAttachment, TerminalEvent, TerminalOpenRequest, TerminalPhase, TerminalSessionInfo,
    TerminalSetupRequest, TerminalSupervisor,
};
pub use translation::TranslationSupervisor;
pub use translation::{AiaBackgroundAnalysis, AiaBackgroundAnalysisRequest};
pub use usage_budget_policy::{
    AcknowledgeDrainNoticeRequest, QuietHours, SavingsDefaults, SetUsageBudgetAccountRequest,
    SetUsageBudgetConsumerRequest, SetUsageBudgetWorkflowRequest, UsageBudgetDefaults,
    UsageBudgetPolicy,
};
pub use usage_history::{AccountUsageHistory, UsageCycleRecord, UsageHistorySnapshot};
pub use usage_pacing::{plan_usage_paced_runs, preview_usage_paced_runs, UsagePacedRunsRequest};
pub use user_path::{
    create_user_directory, normalize_user_path, resolve_existing_directory, CreatedDirectory,
    MISSING_DIRECTORY_PREFIX,
};

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
    /// 같은 공급자 세션을 Agent Manager 관리 런타임이 이미 시작 중이거나 실행 중이다.
    /// WebSocket 거절 응답은 `chat_id`를 함께 보내 기존 실행에 붙을 수 있게 한다.
    #[error("{message}")]
    SessionBusy { message: String, chat_id: String },
    #[error("{0}")]
    ResumeFailed(String),
    #[error("파일이 너무 큽니다. 최대 {0}바이트까지 허용됩니다")]
    TooLarge(u64),
    #[error("{0}")]
    Runtime(String),
    /// 다른 갱신이 진행 중이어서 지금은 받지 못한 요청. 호출자는 잠시 뒤 다시 시도한다.
    #[error("{0}")]
    Busy(String),
}
