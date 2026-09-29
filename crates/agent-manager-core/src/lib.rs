#![recursion_limit = "512"]

mod account_tools;
mod accounts;
mod acp;
mod agent_builtin_tools;
mod aia_onboarding;
mod aia_suggestions;
mod antigravity_usage;
mod app_data_file;
mod app_error;
mod approval_ledger;
mod backend_ownership;
mod backend_service_settings;
mod catalog;
mod catalog_health;
mod chat;
mod chat_runtime_store;
mod chat_secret_cli;
mod chat_secrets;
mod chat_settings;
mod claude_branch_plugins;
mod claude_settings;
mod cli_interface;
mod cli_updates;
mod clock;
mod credential_profiles;
mod cypress_runs;
mod cypress_workspaces;
mod db_approvals;
mod db_cli;
mod db_connections;
mod db_credential_files;
mod db_exec;
mod db_sql;
mod doc_roots;
mod document_automation;
mod document_tree;
mod domain;
mod external_plugins;
mod external_processes;
mod file_kind;
mod git_refs;
mod identifier;
mod instruction_links;
mod instruction_trash;
mod json_store;
mod linked_file;
mod local_llm;
mod loopback_host;
mod markdown_plain;
mod mcp_registry;
mod opencode_config;
mod os_keychain;
mod path_guard;
mod plan;
mod power;
mod process_output;
#[cfg(unix)]
mod process_signal;
mod project_files;
mod project_git;
mod project_instructions;
mod project_registry;
mod provider_settings_file;
mod provider_telemetry;
mod providers;
mod quiet_hours;
mod remote;
mod resource_repository;
mod rounds;
mod saved_secrets;
mod scheduler;
mod session_cleanup;
mod session_context;
mod session_folders;
mod session_management;
mod skill_library;
mod skill_meta;
mod skill_trash;
mod ssh_approvals;
mod ssh_command_line;
mod ssh_command_policy;
mod ssh_endpoints;
mod ssh_exec;
mod ssh_keys;
mod ssh_output;
mod ssh_secrets;
mod staged_replace;
mod storage_reset;
mod store;
mod store_lock;
mod supplement_store;
mod system_mcp;
mod system_skills;
mod system_workflows;
mod tailscale_cli;
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
pub use agent_builtin_tools::{
    load_agent_builtin_tools, AgentBuiltinToolDefinition, AgentBuiltinToolNote,
    AgentBuiltinToolRoute, AgentBuiltinToolView, AgentBuiltinToolsCatalog, AgentBuiltinToolsView,
};
pub use aia_onboarding::{
    load_aia_onboarding_catalog, AiaOnboardingAction, AiaOnboardingCard, AiaOnboardingCardView,
    AiaOnboardingCatalog, AiaOnboardingCatalogIssue, AiaOnboardingField, AiaOnboardingFieldKind,
    AiaOnboardingIcon, AiaOnboardingPack, AiaOnboardingPackSource, AiaOnboardingPackSummary,
    AiaOnboardingSkillTemplate, AiaOnboardingStep, AiaOnboardingTemplateFile, LANE_SKILL_KEY,
};
pub use aia_suggestions::{
    load_aia_suggestion_catalog, AiaSuggestionBundledSkillTemplate, AiaSuggestionCatalog,
    AiaSuggestionCatalogDefinition, AiaSuggestionCatalogIssue, AiaSuggestionDefinition,
    AiaSuggestionEffectivePack, AiaSuggestionKind, AiaSuggestionPack, AiaSuggestionPackSource,
    AiaSuggestionParameterValue, AiaSuggestionRearm, AiaSuggestionSeverity,
    AiaSuggestionTemplateFile,
};
pub use antigravity_usage::{
    antigravity_usage, antigravity_usage_cached_first, exit_if_invoked_as_browser_shim,
};
pub use app_error::{AppError, AppErrorKind};
pub use backend_ownership::BackendOwnershipLease;
pub use backend_service_settings::{
    load_backend_service_settings, save_backend_service_remote_write,
    save_backend_service_settings, BackendServiceSettings, DEFAULT_BACKEND_REMOTE_WRITE,
    DEFAULT_BACKEND_SERVICE_PORT, MAX_BACKEND_SERVICE_PORT, MIN_BACKEND_SERVICE_PORT,
};
pub use catalog::{
    antigravity_session_account, antigravity_session_location, load_agent_detail,
    load_artifact_detail, load_manager_snapshot, load_session_detail,
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
    ChatProviderOptions, ChatReasoningOption, ChatRejectionCode, ChatSecretValueView,
    ChatSecretsGroup, ChatSecretsOverview, ChatSessionInfo, ChatSettingField, ChatSettingFieldKind,
    ChatSettingOption, ChatSshApprovalGate, ChatStartRequest, ChatSupervisor,
    LocalConnectionOptions, ReasoningEffort, ShutdownImpact, StopChatFailure, StopChatReceipt,
    StopProviderChatsReport, MAX_CHAT_INPUT_FILES, MAX_CHAT_INPUT_FILE_BYTES,
    MAX_CHAT_INPUT_IMAGE_BYTES,
};
pub use chat_secret_cli::run_chat_secret_cli;
pub use chat_secrets::{
    validate_secret_name, ChatSecretFileReceipt, ChatSecretFileRequest, ChatSecretRunReceipt,
    ChatSecretRunRequest, ChatSecretSource, ChatSecretSummary, ChatSecretsSnapshot,
    SecretRequestOutcome, SecretRequestTicket, CHAT_SECRET_TTL_MS, PLACEHOLDER_CLOSE,
    PLACEHOLDER_OPEN, SECRET_REQUEST_CARD_KIND, SECRET_REQUEST_TTL_MS,
};
pub use chat_settings::load_chat_provider_options;
pub use claude_branch_plugins::{
    load_claude_plugin_branch_rules, remove_claude_plugin_branch_rule,
    set_claude_plugin_branch_rule, ClaudePluginBranchProject, ClaudePluginBranchRule,
    ClaudePluginBranchRulesSnapshot, RemoveClaudePluginBranchRuleRequest,
    SetClaudePluginBranchRuleRequest,
};
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
pub use db_approvals::{
    DbApprovalCard, DbApprovalConsume, DbApprovalDecision, DbApprovalGate, DbApprovalKind,
    DbApprovalOpen, DbApprovalStore, DbApprovalTicket, DB_APPROVAL_TTL_MS,
};
pub use db_cli::run_db_cli;
pub use db_connections::{
    connection_defaults, get_db_connections, list_agent_db_connections, remove_db_connection,
    set_db_connection, set_db_connection_enabled, AgentDbConnectionSkip, AgentDbConnectionView,
    AgentDbConnectionsView, DbConnectionCheckReceipt, DbConnectionDefaults, DbConnectionRef,
    DbConnectionView, DbConnectionsSnapshot, DbCredentialSource, DbEngineKind, DbEnvironment,
    DbWriteMode, SetDbConnectionEnabledRequest, SetDbConnectionRequest,
};
pub use db_exec::{
    check_db_connection, run_db_query, run_db_statement, DbQueryReceipt, DbQueryRequest,
    DbStatementReceipt, DbStatementRequest,
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
    SkillAdapterRootView, SkillAdapterView, SkillDetail, SkillDivergence, SkillLibrary,
    SkillLibraryEntry, SkillLibraryIssue, SkillOriginKind, SkillProviderState, SkillProviderStatus,
    SkillSummary, StorageOverview, StorageUsageItem, SupplementStorageStats, SystemAgentRuntime,
    SystemAutomationSettings, SystemAutomationSettingsInput, SystemAutomationSnapshot,
    SystemLanguageRequest, TokenUsage, TranscriptImageBlock, TranscriptItem, TranslatedDetail,
    TranslationLanguage, TranslationMenu, TranslationMenuSettings, TranslationStatus,
    TranslationSummary, UiTranslationCatalogInput,
};
pub use external_plugins::{
    ExternalPluginIdRequest, ExternalPluginManifestRequest, ExternalPluginOAuthStart,
    ExternalPluginRegistry, ExternalPluginToolCallRequest, ExternalPluginView,
    ExternalPluginsSnapshot, PluginAuthKind, PluginToolPolicy, SetExternalPluginEnabledRequest,
    SetExternalPluginTokenRequest, SetExternalPluginToolPoliciesRequest,
    SetExternalPluginToolPolicyRequest,
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
pub use linked_file::{
    copy_linked_file_source, save_linked_file_download, LinkedFile, LinkedFileCopy,
    LinkedFileDownload, LinkedFileSource,
};
pub use local_llm::{
    get_local_llm_connection, get_local_llm_connection_by_id, get_local_llm_connections,
    probe_local_llm, remove_local_llm_connection, set_default_local_llm_connection,
    set_local_llm_connection, upsert_local_llm_connection, LocalLlmConnection,
    LocalLlmConnectionEntry, LocalLlmConnectionIdRequest, LocalLlmConnections, LocalLlmProbeResult,
    SetLocalLlmConnectionRequest, UpsertLocalLlmConnectionRequest, DEFAULT_CONNECTION_ID,
};
pub use power::{
    apply_saved_sleep_prevention, release_sleep_prevention, set_sleep_prevention,
    sleep_prevention_status, SleepPreventionStatus,
};
pub use project_files::{
    is_restricted_project_root, list_project_entries, read_project_file, ListProjectEntriesRequest,
    ProjectFileView, ReadProjectFileRequest,
};
pub use project_git::{
    commit_project_git, fetch_project_git, project_git_commit_files, project_git_diff,
    project_git_log, project_git_overview, project_git_status, pull_project_git, push_project_git,
    rebase_project_git, stage_project_git_paths, stash_project_git, switch_project_git_branch,
    unstage_project_git_paths, GitActionReceipt, GitBranch, GitChangeKind, GitCommit,
    GitCommitFile, GitCommitFiles, GitDiff, GitDiffKind, GitHead, GitInProgress, GitInProgressKind,
    GitLog, GitOutcome, GitOverview, GitPullMode, GitRebaseAction, GitRemote, GitRepositoryInfo,
    GitStash, GitStashAction, GitStatus, GitStatusEntry, GitUnavailableReason, GitUpstream,
    GitWorktree, ProjectGitCommitFilesRequest, ProjectGitCommitRequest, ProjectGitDiffRequest,
    ProjectGitFetchRequest, ProjectGitLogRequest, ProjectGitPathsRequest, ProjectGitPullRequest,
    ProjectGitPushRequest, ProjectGitRebaseRequest, ProjectGitStashRequest,
    ProjectGitSwitchRequest, ProjectGitTarget,
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
    InstructionDeleteReceipt, InstructionDeploymentLinkRequest, InstructionDeploymentTarget,
    InstructionImportLinkedDoc, InstructionImportPreview, InstructionImportPreviewRequest,
    InstructionLinkIssue, InstructionLinkedFileResult, InstructionProviderFileWrite,
    InstructionPublishOutcome, InstructionPublishReceipt, InstructionSyncReceipt,
    InstructionUpdateReceipt, ProjectInstructionDeployment, ProjectInstructionEntry,
    ProjectInstructionFileContent, ProjectInstructionIssue, ProjectInstructionLibrary,
    ProjectInstructionMigrationPlan, PublishProjectInstructionRequest,
    ReadDeployedInstructionFileRequest, SaveProjectInstructionPlatformVariantRequest,
    SetProjectInstructionPlatformsRequest, SyncProjectInstructionRequest,
    UnarchiveSharedProjectInstructionRequest, UpdateProjectInstructionRequest,
};
pub use provider_telemetry::{
    load_provider_telemetry, set_provider_telemetry_option, ProviderTelemetryFile,
    ProviderTelemetrySnapshot, SetProviderTelemetryOptionRequest, TelemetryOptionState,
};
pub use providers::inspect_local_environment;
pub use remote::{
    decode_percent_header, load_tailscale_backend_launch, run_remote_server_from_args,
    RemoteAccessPhase, RemoteAccessSettingsInput, RemoteAccessStatus, RemoteAccessSupervisor,
    TailscaleBackendLaunch,
};
pub use resource_repository::{
    load_resource_repository_settings, set_resource_repository, HostPlatform,
    ResourcePlatformManifest, ResourceRepositorySettings, SetResourceRepositoryRequest,
};
pub use rounds::{
    create_round_goal, delete_round_goal, delete_round_report, get_round_goal, get_round_report,
    list_round_goals, list_round_reports, record_round_report, resolve_round_decision,
    update_round_goal, RoundDecision, RoundFailureKind, RoundGoal, RoundGoalInput, RoundGoalPatch,
    RoundGoalStatus, RoundMeasure, RoundOutcome, RoundReport, RoundReportInput, RoundReportQuery,
};
pub use saved_secrets::{
    list_saved_secrets, remove_saved_secret, save_secret, set_saved_secret_agent_enabled,
    SavedSecretValueView, SavedSecretView, SavedSecretsSnapshot,
};
pub use scheduler::{
    ResumeFailurePolicy, ScheduleFrequency, ScheduleRecurrence, ScheduleRun, ScheduleRunRound,
    ScheduleRunStatus, ScheduleSessionStrategy, ScheduleWorkflowAction, ScheduleWorkflowExecutor,
    ScheduledDocumentTriggerContext, ScheduledRequest, ScheduledRequestInput,
    ScheduledRunCancellationReceipt, SchedulerAttachment, SchedulerEvent, SchedulerHandle,
    SchedulerSnapshot, SchedulerSupervisor,
};
pub use session_cleanup::{
    clear_session_cleanup_tombstones, run_session_cleanup, session_cleanup_status,
    set_session_cleanup_policy, spawn_session_cleanup_loop, SessionCleanupEntry,
    SessionCleanupPolicy, SessionCleanupPolicyInput, SessionCleanupPreview, SessionCleanupReason,
    SessionCleanupReasonCount, SessionCleanupReceipt, SessionCleanupSkipCount,
    SessionCleanupStatus,
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
    SessionManagementStatus, SessionScopeFilters, SessionSortField, SessionStatisticsRequest,
    SessionStatisticsResponse, SessionStatisticsTotals, SessionTranscriptPageRequest,
    SessionTranscriptPageResponse, SortDirection, StartChatDelivery, StartChatRequest,
    SwitchActiveProviderAccountReceipt, SwitchActiveProviderAccountRequest, SystemAuditListRequest,
    SystemAuditListResponse, SystemAuditPhase, SystemAuditRecord, TranscriptAppliedFilters,
    TranscriptCategory,
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
pub use ssh_approvals::{
    SshApprovalCard, SshApprovalConsume, SshApprovalDecision, SshApprovalGate, SshApprovalOpen,
    SshApprovalScope, SshApprovalStore, SshApprovalTicket, SSH_APPROVAL_TTL_MS,
};
pub use ssh_endpoints::{
    check_ssh_endpoint, command_policy_defaults, list_agent_ssh_endpoints, run_ssh_endpoint_cli,
    set_ssh_key_endpoint, ssh_key_install_launch, ssh_terminal_launch, AgentSshEndpointSkip,
    AgentSshEndpointView, AgentSshEndpointsView, SetSshKeyEndpointRequest,
    SshCommandPolicyDefaults, SshCommandPolicyMode, SshEndpointCheckReceipt, SshEndpointView,
    SshTerminalLaunch, RELAY_CHAT_ID_ENV,
};
pub use ssh_exec::{
    allow_ssh_command_permanently, download_ssh_file, execute_ssh_command, upload_ssh_file,
    AllowSshCommandRequest, DownloadSshFileRequest, ExecuteSshCommandRequest,
    SshCommandAllowlistReceipt, SshCommandReceipt, SshDownloadReceipt, SshOutputStream,
    SshTerminalSink, SshUploadReceipt, UploadSshFileRequest,
};
pub use ssh_keys::{
    delete_ssh_key, generate_ssh_key, get_ssh_keys, read_ssh_public_key, set_ssh_key_note,
    GenerateSshKeyRequest, SetSshKeyNoteRequest, SshKeyDeletionReceipt, SshKeyIssue, SshKeyRef,
    SshKeyView, SshKeysSnapshot, SshPublicKeyView,
};
pub use storage_reset::prepare_account_management_storage;
pub use store::{
    add_doc_root, create_doc, create_session_folder, delete_session_folder, doc_root_paths,
    list_doc_roots, list_doc_tree, list_document_entries, list_session_folders, read_doc,
    read_doc_linked_file, read_doc_linked_file_download, read_doc_linked_file_source,
    read_document_file, read_document_file_download, read_document_file_source, remove_doc_root,
    reorder_session_folder, save_doc, search_document_entries, session_meta, set_project_active,
    update_session_folder, update_session_meta, FolderMoveDirection, MAX_SESSION_FOLDER_DEPTH,
};
pub use system_mcp::SystemMcpServer;
pub use terminal::{
    StopProviderTerminalsReport, StopTerminalFailure, TerminalAccountLoginRequest,
    TerminalAttachment, TerminalEvent, TerminalOpenRequest, TerminalPhase, TerminalSessionInfo,
    TerminalSetupRequest, TerminalSshRequest, TerminalSupervisor,
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
    create_user_directory, normalize_user_path, plan_user_directory, resolve_existing_directory,
    CreatedDirectory, DirectoryCreationPlan, MAX_NEW_DIRECTORY_SEGMENTS, MISSING_DIRECTORY_PREFIX,
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
    /// 화면이 문구를 스스로 정할 수 있게 안정 코드와 파라미터를 함께 나르는 실패.
    /// 한국어 문장도 함께 들고 있어 코드를 모르는 소비자는 예전과 똑같이 읽는다.
    /// 모듈을 하나씩 이 갈래로 옮기는 중이며, 설계는 [`app_error`]에 있다.
    #[error("{0}")]
    Coded(#[from] AppError),
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
