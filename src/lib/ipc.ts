import type { SavingsDefaults, SetUsageBudgetAccountRequest, SetUsageBudgetConsumerRequest, UsageBudgetDefaults, UsageBudgetSnapshot } from "../types";
import type { AccountLoginSessionView, AccountSnapshot, AccountToolsSnapshot, AccountUsageView, AgentDetail, ArtifactDetail, AutoSwitchPolicy, BackgroundSettings, CatalogHealth, ChatAttentionSnapshot, ChatProfile, ChatProviderOptions, ChatSessionInfo, ClaudeSettingsSnapshot, CliUpdateReceipt, CommonSkillDetail, CommonSkillDigest, CommonSkillSource, CreateProjectInstructionRequest, CypressInstallReceipt, CypressRegistry, CypressRunStatus, CypressWorkspaceFile, CypressWorkspaceFileContent,DeployedInstructionFileContent, DocFile, DocRootStatus, DocumentAutomationSnapshot, DocumentEntryPage, DocumentFile, DocumentTrigger, DocumentTriggerInput, DocumentTriggerRun, HostPlatform, ImportProjectInstructionRequest, InstructionDeleteCheckRequest, InstructionDeleteImpact, InstructionDeleteReceipt, InstructionDeploymentLinkRequest, InstructionImportPreview, InstructionImportPreviewRequest, InstructionPublishReceipt, InstructionSyncReceipt, InstructionTrashOverview, InstructionTrashRestoreReceipt, InstructionUpdateReceipt, LinkedFile, ManagerSnapshot, MenuTranslations, ModelCacheCleanupReceipt, ProjectInstructionEntry, ProjectInstructionFileContent, ProjectInstructionLibrary, ProjectInstructionMigrationPlan, ProjectRegistryEntry, ProviderCliUpdateStatus, ProviderAccountView, ProviderId, ProviderRuntimeCounts, PublishProjectInstructionRequest, ResetCreditOutcome, ResourceRepositorySettings, ResumeAccountPolicy, ScheduleRunDetail, ScheduledRequest, ScheduledRequestInput, ScheduledRunCancellationReceipt, SchedulerSnapshot, SessionCatalogUpdate, SessionDetail, SessionFolder, SessionMeta, SessionMetaPatch, SessionSummary, SessionTranscriptLimit, SetClaudePluginEnabledRequest, SetClaudeSkillOverrideRequest, SetProjectActiveRequest, SetProjectInstructionPlatformsRequest, SetResourceRepositoryRequest, SetSkillPlatformsRequest, SetSystemWorkflowPacingRequest, SkillDeleteReceipt, SkillDetail, SkillFileContent, SkillFileWrite, SkillInstallComparison, SkillLibrary, SkillLocation, SkillMigrationPlan, SkillOverwritePolicy, SkillPublishReceipt, SkillSyncReceipt, SkillTrashOverview, SkillTrashRestoreReceipt, SkillUpdateReceipt, SourceCounts, SourceTotals, StorageOverview, SwitchActiveProviderAccountReceipt, SyncProjectInstructionRequest, SystemAutomationSettingsInput, SystemAutomationSnapshot, SystemLanguageRequest, SystemWorkflowDetail, SystemWorkflowExecution, SystemWorkflowList, TranslatedDetail, TranslationMenu, UpdateProjectInstructionRequest, UsageHistorySnapshot, ExternalPluginOAuthStart, ExternalPluginView, ExternalPluginsSnapshot, PluginToolPolicy, RegisterExternalPluginRequest, UpdateExternalPluginRequest } from "../types";
import { sessionTranscriptImagePath, type TranscriptImageRef } from "./sessionImage";
import { backendHttpUrl, hasNativeShell } from "./backend";
import { call, nativeCall, remoteFetch, responseError } from "./ipcTransport";
export {
  downloadChatLinkedFile,
  downloadDeployedInstructionLinkedFile,
  downloadDocLinkedFile,
  downloadDocumentFile,
  downloadSessionLinkedFile,
} from "./ipcLinkedFile";
export {
  BackendBusyError,
  BackendTimeoutError,
  RemoteConnectionError,
  getBackendServiceSettings,
  getWebAccessStatus,
  initializeBackendService,
  setBackendServiceSettings,
} from "./ipcTransport";
export type { BackendServiceSettings, WebAccessStatus, WebAccessStatusOptions } from "./ipcTransport";
import type { AiaSuggestionCatalog } from "./aiaSuggestions";
import type { GenerateSshKeyRequest, SetSshKeyEndpointRequest, SetSshKeyNoteRequest, SshEndpointCheckReceipt, SshKeyDeletionReceipt, SshKeyRef, SshKeyView, SshKeysSnapshot, SshPublicKeyView } from "../types";

export function hasTauriRuntime(): boolean {
  return hasNativeShell();
}

export function showNativeNotification(title: string, body: string): Promise<void> {
  return nativeCall<void>("show_native_notification", { title, body });
}

/// 데스크톱 셸을 재시작해 저장된 서비스 포트를 실제 수신 포트로 만든다.
/// 프로세스가 그대로 종료되므로 이 호출은 정상 경로에서 resolve되지 않는다.
export function restartApp(): Promise<void> {
  return nativeCall<void>("restart_app");
}

export interface TailscaleServiceStatus {
  available: boolean;
  enabled: boolean;
  host: string | null;
  login: string | null;
  url: string | null;
  servicePort: number;
  serveTarget: string | null;
  conflictTarget: string | null;
  remoteAccepted: boolean;
  remoteWrite: boolean;
  error: string | null;
}

export function getTailscaleServiceStatus(): Promise<TailscaleServiceStatus> {
  return call<TailscaleServiceStatus>("get_tailscale_service_status");
}

export function setTailscaleServiceEnabled(
  enabled: boolean,
  replaceExisting = false,
): Promise<TailscaleServiceStatus> {
  return call<TailscaleServiceStatus>("set_tailscale_service_enabled", { enabled, replaceExisting });
}

/**
 * 원격 UI에 데스크톱과 같은 변경 권한을 줄지 바꿉니다. 저장 지점은 백엔드 서비스
 * 설정 하나이고 실행 중인 백엔드에 바로 반영되며, 호스트 화면에서만 호출할 수 있습니다.
 */
export function setRemoteWriteEnabled(enabled: boolean): Promise<TailscaleServiceStatus> {
  return call<TailscaleServiceStatus>("set_remote_write_enabled", { enabled });
}

/** 호스트 자동 절전 억제 상태. 억제 수단은 OS마다 다르므로 어떤 수단인지 함께 알린다. */
export interface SleepPreventionStatus {
  /** 이 호스트에서 억제 수단을 쓸 수 있는지. */
  supported: boolean;
  /** 저장된 설정값. */
  enabled: boolean;
  /** 지금 실제로 걸려 있는지. 설정이 켜져 있어도 수단이 없으면 거짓이다. */
  active: boolean;
  /** `caffeinate`, `systemd-inhibit`, `SetThreadExecutionState` 중 하나. */
  mechanism: string | null;
  error: string | null;
}

export function getSleepPrevention(): Promise<SleepPreventionStatus> {
  return call<SleepPreventionStatus>("get_sleep_prevention");
}

export function setSleepPrevention(enabled: boolean): Promise<SleepPreventionStatus> {
  return call<SleepPreventionStatus>("set_sleep_prevention", { enabled });
}

export function getProviderAccounts(): Promise<AccountSnapshot> {
  return call<AccountSnapshot>("get_provider_accounts");
}

/** 계정별로 쓸 수 있는 외부 MCP·커넥터·플러그인 요약. 도구를 실행하지 않는 조회다. */
export function getAccountTools(): Promise<AccountToolsSnapshot> {
  return call<AccountToolsSnapshot>("get_account_tools");
}

/** 계정별 사용량 주기 이력. 앱 데이터의 파생 이력만 읽는 순수 조회다. */
export function getAccountUsageHistory(): Promise<UsageHistorySnapshot> {
  return call<UsageHistorySnapshot>("get_account_usage_history");
}

/** 외부 플러그인(MCP 서버) 목록. 비밀값은 실리지 않는다. */
export function getExternalPlugins(): Promise<ExternalPluginsSnapshot> {
  return call<ExternalPluginsSnapshot>("get_external_plugins");
}

/** 로컬 ~/.ssh 공개키의 비밀 없는 메타데이터. 개인키 파일은 열지 않는다. */
export function getSshKeys(): Promise<SshKeysSnapshot> {
  return call<SshKeysSnapshot>("get_ssh_keys");
}

/** 기존 파일을 덮어쓰지 않는 호스트 전용 Ed25519 키 생성. */
export function generateSshKey(request: GenerateSshKeyRequest): Promise<SshKeyView> {
  return call<SshKeyView>("generate_ssh_key", { request }, { timeoutMs: 45_000 });
}

/** 고른 공개키의 본문 한 줄. 공개키라 비밀값이 아니며 개인키는 열지 않는다. */
export function readSshPublicKey(request: SshKeyRef): Promise<SshPublicKeyView> {
  return call<SshPublicKeyView>("read_ssh_public_key", { request });
}

/** 키 쌍을 ~/.ssh 안 휴지통으로 옮기는 호스트 전용 삭제. 파일을 되옮기면 복구된다. */
export function deleteSshKey(request: SshKeyRef): Promise<SshKeyDeletionReceipt> {
  return call<SshKeyDeletionReceipt>("delete_ssh_key", { request });
}

/** 지문에 묶인 기기 단위 메모. 빈 문자열은 메모 삭제다. */
export function setSshKeyNote(request: SetSshKeyNoteRequest): Promise<SshKeysSnapshot> {
  return call<SshKeysSnapshot>("set_ssh_key_note", { request });
}

/** 인증키별 접속 지점과 에이전트 사용 여부. 앱 데이터에만 쓰는 호스트 전용 설정이다. */
export function setSshKeyEndpoint(request: SetSshKeyEndpointRequest): Promise<SshKeysSnapshot> {
  return call<SshKeysSnapshot>("set_ssh_key_endpoint", { request });
}

/** 저장된 접속 지점으로 한 번 붙어 보는 호스트 전용 확인. 원격에서는 아무것도 바꾸지 않는다. */
export function checkSshEndpoint(request: SshKeyRef): Promise<SshEndpointCheckReceipt> {
  return call<SshEndpointCheckReceipt>("check_ssh_endpoint", { request }, { timeoutMs: 30_000 });
}

/** Claude Code 플러그인·일반 스킬의 전역/프로젝트 설정과 유효값. */
export function getClaudeSettingsStates(projectPath: string | null = null): Promise<ClaudeSettingsSnapshot> {
  return call<ClaudeSettingsSnapshot>("get_claude_settings_states", { projectPath });
}

export function setClaudePluginEnabled(request: SetClaudePluginEnabledRequest): Promise<ClaudeSettingsSnapshot> {
  return call<ClaudeSettingsSnapshot>("set_claude_plugin_enabled", { request });
}

export function setClaudeSkillOverride(request: SetClaudeSkillOverrideRequest): Promise<ClaudeSettingsSnapshot> {
  return call<ClaudeSettingsSnapshot>("set_claude_skill_override", { request });
}

/** 플러그인 등록. 토큰·client_secret은 호스트에서만 보내며 응답에 돌아오지 않는다. */
export function registerExternalPlugin(request: RegisterExternalPluginRequest): Promise<ExternalPluginView> {
  return call<ExternalPluginView>("register_external_plugin", { ...request });
}

/** 플러그인 편집. 주소·인증 방식·client_id·client_secret가 바뀌면 저장된 자격증명과 연결 확인 결과가 초기화된다. */
export function updateExternalPlugin(request: UpdateExternalPluginRequest): Promise<ExternalPluginView> {
  return call<ExternalPluginView>("update_external_plugin", { ...request });
}

export function removeExternalPlugin(id: string): Promise<{ removed: boolean; id: string }> {
  return call<{ removed: boolean; id: string }>("remove_external_plugin", { id });
}

export function setExternalPluginEnabled(id: string, enabled: boolean): Promise<ExternalPluginView> {
  return call<ExternalPluginView>("set_external_plugin_enabled", { id, enabled });
}

/** 도구 하나의 허용/확인/제한. 제한은 다음 요청부터, 허용은 새로 시작하는 채팅부터 듣는다. */
export function setExternalPluginToolPolicy(id: string, tool: string, policy: PluginToolPolicy): Promise<ExternalPluginView> {
  return call<ExternalPluginView>("set_external_plugin_tool_policy", { id, tool, policy });
}

/** 현재 알려진 도구 전체를 한 번의 저장으로 같은 권한에 맞춘다. */
export function setExternalPluginToolPolicies(id: string, policy: PluginToolPolicy): Promise<ExternalPluginView> {
  return call<ExternalPluginView>("set_external_plugin_tool_policies", { id, policy });
}

export function setExternalPluginToken(id: string, token: string): Promise<ExternalPluginView> {
  return call<ExternalPluginView>("set_external_plugin_token", { id, token });
}

/** OAuth 승인 주소를 받는다. 호스트 화면이 브라우저로 열고, 콜백은 백엔드 loopback이 받는다. */
export function beginExternalPluginOAuth(id: string): Promise<ExternalPluginOAuthStart> {
  return call<ExternalPluginOAuthStart>("begin_external_plugin_oauth", { id }, { timeoutMs: 60_000 });
}

export function cancelExternalPluginOAuth(id: string): Promise<ExternalPluginView> {
  return call<ExternalPluginView>("cancel_external_plugin_oauth", { id });
}

/** CLI가 쓰는 프록시 경로로 initialize·tools/list를 실행해 연결과 인증을 확인한다. */
export function verifyExternalPlugin(id: string): Promise<ExternalPluginView> {
  return call<ExternalPluginView>("verify_external_plugin", { id }, { timeoutMs: 150_000 });
}

export function beginProviderAccountLogin(
  source: ProviderId,
  accountId?: string | null,
): Promise<AccountLoginSessionView> {
  return call<AccountLoginSessionView>("begin_provider_account_login", { source, accountId });
}

export function finishProviderAccountLogin(
  loginId: string,
  displayName?: string | null,
): Promise<AccountSnapshot> {
  return call<AccountSnapshot>("finish_provider_account_login", { loginId, displayName });
}

export function cancelProviderAccountLogin(loginId: string): Promise<void> {
  return call<void>("cancel_provider_account_login", { loginId });
}

/** 공급자 CLI 버전과 설치 출처, 모델 캐시 상태. 네트워크 조회 없이 로컬만 확인한다. */
export function getCliUpdateStatus(): Promise<ProviderCliUpdateStatus[]> {
  return call<ProviderCliUpdateStatus[]>("get_cli_update_status");
}

/** 종료 확인창에 보여줄 실행 중 관리 채팅·터미널·외부 프로세스 수. */
export function getProviderRuntimeCounts(provider: ProviderId): Promise<ProviderRuntimeCounts> {
  return call<ProviderRuntimeCounts>("get_provider_runtime_counts", { provider });
}

/** 설치 출처의 패키지 관리자에서 최신 버전을 조회한다. 호스트 로컬 UI 전용. */
export function checkProviderCliUpdate(provider: ProviderId): Promise<ProviderCliUpdateStatus> {
  return call<ProviderCliUpdateStatus>("check_provider_cli_update", { provider });
}

/** 확인된 설치 출처의 고정 명령으로 CLI를 업데이트한다. 호스트 로컬 UI 전용. */
export function updateProviderCli(provider: ProviderId): Promise<CliUpdateReceipt> {
  return call<CliUpdateReceipt>("update_provider_cli", { provider });
}

/** 실행 버전과 기록 버전이 다른 모델 카탈로그 캐시만 정리한다. 호스트 로컬 UI 전용. */
export function clearProviderModelCaches(provider: ProviderId): Promise<ModelCacheCleanupReceipt> {
  return call<ModelCacheCleanupReceipt>("clear_provider_model_caches", { provider });
}

/** 기본 계정을 바꾼다. 자격증명 교체가 없어 실행 중 세션은 종료하지 않는다. */
export function switchActiveProviderAccount(accountId: string): Promise<SwitchActiveProviderAccountReceipt> {
  return call<SwitchActiveProviderAccountReceipt>("switch_active_provider_account", { accountId });
}

export function setProviderAccountDisabled(
  accountId: string,
  disabled: boolean,
): Promise<AccountSnapshot> {
  return call<AccountSnapshot>("set_provider_account_disabled", { accountId, disabled });
}

export function setProviderAccountAutoSwitch(
  accountId: string,
  autoSwitch: boolean,
): Promise<AccountSnapshot> {
  return call<AccountSnapshot>("set_provider_account_auto_switch", { accountId, autoSwitch });
}

/** 계정별 사용자 메모를 저장한다. null을 보내면 저장된 메모를 삭제한다. */
export function setProviderAccountNote(
  accountId: string,
  note: string | null,
): Promise<AccountSnapshot> {
  return call<AccountSnapshot>("set_provider_account_note", { accountId, note });
}

/**
 * 계정 표시 이름을 사용자가 정한 값으로 바꾼다. null이나 빈 문자열을 보내면 사용자
 * 지정을 지우고 공급자가 알려 준 이름으로 되돌린다.
 */
export function setProviderAccountLabel(
  accountId: string,
  label: string | null,
): Promise<AccountSnapshot> {
  return call<AccountSnapshot>("set_provider_account_label", { accountId, label });
}

export function setAutoSwitchResume(enabled: boolean): Promise<AccountSnapshot> {
  return call<AccountSnapshot>("set_auto_switch_resume", { enabled });
}

/** 페일오버 우선순위. null을 보내면 지정을 해제한다. */
export function setProviderAccountAutoSwitchPriority(
  accountId: string,
  priority: number | null,
): Promise<AccountSnapshot> {
  return call<AccountSnapshot>("set_provider_account_auto_switch_priority", { accountId, priority });
}

export function setAutoSwitchPolicy(policy: AutoSwitchPolicy): Promise<AccountSnapshot> {
  return call<AccountSnapshot>("set_auto_switch_policy", { policy });
}

/**
 * 사용량 분산 교체 폭(1~99, %p)을 바꾼다. null을 보내면 분산 교체를 끄고 100% 도달과
 * 에이전트 제한 응답에서만 페일오버한다.
 */
export function setAutoSwitchUsageGap(percent: number | null): Promise<AccountSnapshot> {
  return call<AccountSnapshot>("set_auto_switch_usage_gap", { percent });
}

/**
 * 이어가기 실행 계정 선택 방식을 바꾼다. 이미 떠 있는 런타임은 시작 시점 계정을
 * 유지하므로 다음 이어가기부터 적용된다.
 */
export function setResumeAccountPolicy(policy: ResumeAccountPolicy): Promise<AccountSnapshot> {
  return call<AccountSnapshot>("set_resume_account_policy", { policy });
}

/**
 * 계정 사용량을 계정별로 동시에 다시 조회한다. 계정별 응답이 전체 스냅샷이라
 * 순차 호출은 서로의 결과를 덮어쓰므로, 여러 계정을 갱신할 때는 이 호출을 쓴다.
 * 백엔드는 계정마다 갱신 주기(활성·실행 중 5분, 유휴 30분)를 지켜 대상을 다시 거르므로,
 * 폴링은 그대로 부르고 사용자가 직접 누른 새로고침만 `force`로 주기를 무시한다.
 */
export function refreshProviderAccountUsages(provider?: ProviderId, force = false): Promise<AccountSnapshot> {
  return call<AccountSnapshot>("refresh_provider_account_usages", { ...(provider ? { provider } : {}), ...(force ? { force } : {}) });
}

export function deleteProviderAccount(accountId: string): Promise<AccountSnapshot> {
  return call<AccountSnapshot>("delete_provider_account", { accountId });
}

export function refreshProviderAccountUsage(accountId: string): Promise<AccountSnapshot> {
  return call<AccountSnapshot>("refresh_provider_account_usage", { accountId });
}

/**
 * 한도 리셋 크레딧 한 장을 써서 소진된 사용량 창을 되돌린다. 되돌릴 수 없고 장수가
 * 한정돼 있으므로 확인을 받은 뒤에만 부른다. 한도를 충분히 쓰지 않았으면
 * `nothingToReset`으로 물리고 크레딧은 남는다.
 */
export function consumeAccountResetCredit(accountId: string): Promise<{ outcome: ResetCreditOutcome; accounts: AccountSnapshot }> {
  return call<{ outcome: ResetCreditOutcome; accounts: AccountSnapshot }>("consume_account_reset_credit", { accountId });
}

export function revalidateProviderAccountCredential(accountId: string): Promise<AccountSnapshot> {
  return call<AccountSnapshot>("revalidate_provider_account_credential", { accountId });
}

export function getManagerSnapshot(): Promise<ManagerSnapshot> {
  return call<ManagerSnapshot>("get_manager_snapshot").then(normalizeManagerSnapshot);
}

/**
 * 세션 색인 갱신 제한 시간. 백엔드가 응답하지 않으면 화면이 조용히 오래된 목록을
 * 계속 보여 주기 때문에(단일 비행 가드가 영구 대기 상태로 남는다) 반드시 끊어 준다.
 * 새 대화 기록이 많이 쌓인 뒤의 정상 전체 조정도 수십 초가 걸릴 수 있어 넉넉히 잡는다.
 */
const SESSION_CATALOG_RECONCILE_TIMEOUT_MS = 60_000;
/** 단일 세션 색인 갱신 제한 시간. 호출부가 여러 번 재시도하므로 짧게 잡는다. */
const SESSION_CATALOG_REFRESH_TIMEOUT_MS = 15_000;

export function reconcileSessionCatalog(): Promise<SessionCatalogUpdate> {
  return call<SessionCatalogUpdate>("reconcile_session_catalog", {}, {
    timeoutMs: SESSION_CATALOG_RECONCILE_TIMEOUT_MS,
  });
}

export function refreshSessionCatalog(
  source: ProviderId,
  id: string,
): Promise<SessionCatalogUpdate> {
  return call<SessionCatalogUpdate>("refresh_session_catalog", { request: { source, id } }, {
    timeoutMs: SESSION_CATALOG_REFRESH_TIMEOUT_MS,
  });
}

export function getCatalogHealth(): Promise<CatalogHealth> {
  return call<CatalogHealth>("get_catalog_health");
}

export function getStorageOverview(): Promise<StorageOverview> {
  return call<StorageOverview>("get_storage_overview");
}

function normalizeManagerSnapshot(snapshot: ManagerSnapshot): ManagerSnapshot {
  const normalizeSession = (session: SessionSummary): SessionSummary => ({
    ...session,
    meta: normalizeSessionMeta(session.meta),
  });

  return {
    ...snapshot,
    sessionCatalogRevision: snapshot.sessionCatalogRevision ?? 0,
    resourceCatalogRevision: snapshot.resourceCatalogRevision ?? 0,
    sessions: snapshot.sessions.map(normalizeSession),
    folders: snapshot.folders ?? [],
    dashboard: {
      ...snapshot.dashboard,
      sessionsBySource: normalizeSourceCounts(snapshot.dashboard.sessionsBySource),
      tokens: normalizeSourceTotals(snapshot.dashboard.tokens),
      disk: normalizeSourceTotals(snapshot.dashboard.disk),
      weekly: snapshot.dashboard.weekly.map((week) => ({
        ...week,
        ...normalizeSourceCounts(week),
      })),
      recent: snapshot.dashboard.recent.map(normalizeSession),
    },
  };
}

export function getUsageBudget(): Promise<UsageBudgetSnapshot> {
  return call<UsageBudgetSnapshot>("get_usage_budget");
}

export function setUsageBudgetPolicy(request: UsageBudgetDefaults): Promise<UsageBudgetSnapshot> {
  return call<UsageBudgetSnapshot>("set_usage_budget_policy", { request });
}

/**
 * 소진 마감 안내를 봤다고 기록해 같은 크레딧으로 다시 알리지 않게 한다. `creditId`를 비우면
 * 기록을 지워 다시 알린다.
 */
export function acknowledgeDrainNotice(accountId: string, creditId: string | null): Promise<UsageBudgetSnapshot> {
  return call<UsageBudgetSnapshot>("acknowledge_drain_notice", { request: { accountId, creditId } });
}

export function setUsageBudgetAccount(request: SetUsageBudgetAccountRequest): Promise<UsageBudgetSnapshot> {
  return call<UsageBudgetSnapshot>("set_usage_budget_account", { request });
}

export function setUsageBudgetConsumer(request: SetUsageBudgetConsumerRequest): Promise<UsageBudgetSnapshot> {
  return call<UsageBudgetSnapshot>("set_usage_budget_consumer", { request });
}

export function setUsageBudgetSavings(request: SavingsDefaults): Promise<UsageBudgetSnapshot> {
  return call<UsageBudgetSnapshot>("set_usage_budget_savings", { request });
}

export function getSystemAutomationSnapshot(): Promise<SystemAutomationSnapshot> {
  return call<SystemAutomationSnapshot>("get_system_automation_snapshot");
}

export function setSystemAutomationSettings(
  request: SystemAutomationSettingsInput,
): Promise<SystemAutomationSnapshot> {
  return call<SystemAutomationSnapshot>("set_system_automation_settings", { request });
}

export function requestSystemLanguage(
  request: SystemLanguageRequest,
): Promise<SystemAutomationSnapshot> {
  return call<SystemAutomationSnapshot>("request_system_language", { request });
}

export function retryUiTranslation(): Promise<SystemAutomationSnapshot> {
  return call<SystemAutomationSnapshot>("retry_ui_translation");
}

export function cancelUiTranslation(): Promise<SystemAutomationSnapshot> {
  return call<SystemAutomationSnapshot>("cancel_ui_translation");
}

export function getMenuTranslations(menu: TranslationMenu): Promise<MenuTranslations> {
  return call<MenuTranslations>("get_menu_translations", { menu });
}

export function getTranslatedDetail(
  menu: TranslationMenu,
  resourceId: string,
): Promise<TranslatedDetail> {
  return call<TranslatedDetail>("get_translated_detail", { menu, resourceId });
}

export function retryMenuTranslation(menu: TranslationMenu): Promise<SystemAutomationSnapshot> {
  return call<SystemAutomationSnapshot>("retry_menu_translation", { menu });
}

/** 저장된 번역을 버리고 해당 메뉴를 처음부터 다시 번역한다. */
export function resetMenuTranslation(menu: TranslationMenu): Promise<SystemAutomationSnapshot> {
  return call<SystemAutomationSnapshot>("reset_menu_translation", { menu });
}

/**
 * 리소스 하나와 그 리소스의 모든 필드를 지금 번역한다. 메뉴 자동번역 토글과 무관하게
 * 동작하고, 이미 번역이 있으면 캐시를 건너뛰고 다시 번역한다.
 */
export function translateResource(
  menu: TranslationMenu,
  resourceId: string,
): Promise<SystemAutomationSnapshot> {
  return call<SystemAutomationSnapshot>("translate_resource", { menu, resourceId });
}

function normalizeSessionMeta(meta: Partial<SessionMeta> | null | undefined): SessionMeta {
  return {
    favorite: Boolean(meta?.favorite),
    hidden: Boolean(meta?.hidden),
    note: meta?.note ?? null,
    customTitle: meta?.customTitle ?? null,
    folderIds: Array.isArray(meta?.folderIds) ? meta.folderIds : [],
    reasoningEffort: meta?.reasoningEffort ?? null,
    mode: meta?.mode ?? null,
    approvalMode: meta?.approvalMode ?? null,
    creationAccountId: meta?.creationAccountId ?? null,
    boundAccountId: meta?.boundAccountId ?? null,
    pinnedAccountId: meta?.pinnedAccountId ?? null,
  };
}

function normalizeSourceCounts(counts: Partial<SourceCounts> | null | undefined): SourceCounts {
  return {
    claude: counts?.claude ?? 0,
    codex: counts?.codex ?? 0,
    antigravity: counts?.antigravity ?? 0,
  };
}

function normalizeSourceTotals(totals: Partial<SourceTotals> | null | undefined): SourceTotals {
  return {
    ...normalizeSourceCounts(totals),
    total: totals?.total ?? 0,
  };
}

export function getChatProviderOptions(source: ProviderId): Promise<ChatProviderOptions> {
  return call<ChatProviderOptions>("get_chat_provider_options", { source });
}

export function getChatAttentionSnapshot(): Promise<ChatAttentionSnapshot> {
  return call<ChatAttentionSnapshot>("get_chat_attention_snapshot");
}

/** 기존 IPC 이름은 유지하지만, 다중 화면 attach를 위해 연결 여부와 무관하게 현재
 * 공급자 세션을 관리하는 활성 런타임을 돌려준다. */
export function getDetachedChatForSession(
  source: ProviderId,
  id: string,
): Promise<ChatSessionInfo | null> {
  return call<ChatSessionInfo | null>("get_detached_chat_for_session", { request: { source, id } });
}

export function getLiveChats(profile: ChatProfile = "standard"): Promise<ChatSessionInfo[]> {
  return call<ChatSessionInfo[]>("get_live_chats", { profile });
}

/** AIA의 화면 요청(uiQuery·uiClick 이벤트)에 화면이 답한다 — 요소 목록 또는 클릭 결과. */
export function answerUiQuery(queryId: string, answer: unknown): Promise<void> {
  return call<void>("answer_ui_query", { queryId, answer });
}

export function markChatAttentionRead(id: string): Promise<ChatAttentionSnapshot> {
  return call<ChatAttentionSnapshot>("mark_chat_attention_read", { id });
}

/**
 * 읽음 처리를 한 왕복으로 끝낸다. 항목마다 `markChatAttentionRead`를 부르면 미읽음 수만큼
 * HTTP 왕복이 쌓여, 원격으로 붙었을 때 버튼이 굳은 것처럼 보인다.
 * `excludeProfiles`는 화면 목록에서 감춘 프로필을 대상에서 빼는 데 쓴다.
 */
export function markAllChatAttentionRead(excludeProfiles: ChatProfile[] = []): Promise<ChatAttentionSnapshot> {
  return call<ChatAttentionSnapshot>("mark_all_chat_attention_read", { excludeProfiles });
}

export function clearReadChatAttention(): Promise<ChatAttentionSnapshot> {
  return call<ChatAttentionSnapshot>("clear_read_chat_attention");
}

export function dismissChatAttention(id: string): Promise<ChatAttentionSnapshot> {
  return call<ChatAttentionSnapshot>("dismiss_chat_attention", { id });
}

export function getSessionDetail(
  source: ProviderId,
  id: string,
  transcriptLimit: SessionTranscriptLimit = "latest500",
  transcriptBeforeIndex?: number,
): Promise<SessionDetail> {
  return call<SessionDetail>("get_session_detail", {
    request: { source, id, transcriptLimit, transcriptBeforeIndex },
  });
}

export function openProviderSessionApp(source: ProviderId, id: string): Promise<void> {
  return nativeCall<void>("open_provider_session_app", { request: { source, id } });
}

/** Tauri CSP는 loopback 이미지를 직접 삽입하지 않습니다. 네이티브에서는 Blob URL을 씁니다. */
export function directSessionTranscriptImageUrl(
  source: ProviderId,
  id: string,
  image: TranscriptImageRef,
): string | null {
  if (hasNativeShell()) return null;
  return backendHttpUrl(sessionTranscriptImagePath(source, id, image));
}

export async function readSessionTranscriptImage(
  source: ProviderId,
  id: string,
  image: TranscriptImageRef,
): Promise<Blob> {
  const response = await remoteFetch(
    backendHttpUrl(sessionTranscriptImagePath(source, id, image)),
    { cache: "no-store" },
  );
  if (!response.ok) throw await responseError(response, "이미지를 읽지 못했습니다");
  return response.blob();
}

export function getSessionLinkedFile(
  source: ProviderId,
  id: string,
  href: string,
): Promise<LinkedFile> {
  return call<LinkedFile>("get_session_linked_file", { request: { source, id, href } });
}

export function getChatLinkedFile(chatId: string, href: string): Promise<LinkedFile> {
  return call<LinkedFile>("get_chat_linked_file", { request: { chatId, href } });
}

export function patchSessionMeta(
  source: ProviderId,
  id: string,
  patch: SessionMetaPatch,
): Promise<SessionMeta> {
  return call<SessionMeta>("patch_session_meta", { request: { source, id, patch } });
}

/** `parentId`를 주면 그 폴더의 하위로, 비우면 최상위에 만든다. */
export function createSessionFolder(
  name: string,
  color: string,
  parentId?: string | null,
): Promise<SessionFolder> {
  return call<SessionFolder>("create_session_folder", { request: { name, color, parentId: parentId ?? null } });
}

/**
 * `parentId`를 넘기지 않으면 상위 폴더를 그대로 두고, `null`이면 최상위로 올린다.
 * 자기 자신이나 자기 하위 폴더로 옮기려 하면 백엔드가 거부한다. `hidden`을 넘기지
 * 않으면 숨김 여부를 그대로 둔다.
 */
export function updateSessionFolder(
  id: string,
  patch: { name?: string; color?: string; parentId?: string | null; hidden?: boolean },
): Promise<SessionFolder> {
  return call<SessionFolder>("update_session_folder", { request: { id, ...patch } });
}

/**
 * 같은 상위 폴더의 형제 사이에서 한 칸 위나 아래로 옮기고, 새 순서의 폴더 목록을
 * 트리 순서로 돌려준다. 끝이라 바꿀 형제가 없으면 순서를 그대로 둔다.
 */
export function reorderSessionFolder(
  id: string,
  direction: "up" | "down",
): Promise<SessionFolder[]> {
  return call<SessionFolder[]>("reorder_session_folder", { request: { id, direction } });
}

/** 하위 폴더까지 함께 지우고, 지워진 폴더 ID를 트리 순서로 돌려준다. */
export function deleteSessionFolder(id: string): Promise<string[]> {
  return call<string[]>("delete_session_folder", { id });
}

/**
 * 주기 폴링용 스냅샷. 요청 프롬프트와 실행 요약은 미리보기로 잘려 있으므로
 * 전문이 필요하면 getScheduledRequestDetail·getScheduledRunDetail을 쓴다.
 */
export function getSchedulerSnapshot(): Promise<SchedulerSnapshot> {
  return call<SchedulerSnapshot>("get_scheduler_snapshot");
}

export function getScheduledRequestDetail(id: string): Promise<ScheduledRequest> {
  return call<ScheduledRequest>("get_scheduled_request_detail", { id });
}

export function getScheduledRunDetail(id: string): Promise<ScheduleRunDetail> {
  return call<ScheduleRunDetail>("get_scheduled_run_detail", { id });
}

export function createScheduledRequest(input: ScheduledRequestInput): Promise<ScheduledRequest> {
  return call<ScheduledRequest>("create_scheduled_request", { request: input });
}

export function updateScheduledRequest(id: string, input: ScheduledRequestInput): Promise<ScheduledRequest> {
  return call<ScheduledRequest>("update_scheduled_request", { request: { id, input } });
}

export function deleteScheduledRequest(id: string): Promise<void> {
  return call<void>("delete_scheduled_request", { id });
}

export function setScheduleEnabled(id: string, enabled: boolean): Promise<ScheduledRequest> {
  return call<ScheduledRequest>("set_schedule_enabled", { request: { id, enabled } });
}

export function runScheduledRequestNow(id: string): Promise<ScheduledRequest> {
  return call<ScheduledRequest>("run_scheduled_request_now", { id });
}

export function cancelScheduledRun(runId: string, reason?: string): Promise<ScheduledRunCancellationReceipt> {
  return call<ScheduledRunCancellationReceipt>("cancel_scheduled_run", { runId, reason });
}

export function setSchedulesPaused(paused: boolean): Promise<SchedulerSnapshot> {
  return call<SchedulerSnapshot>("set_schedules_paused", { paused });
}

export function getBackgroundSettings(): Promise<BackgroundSettings> {
  return nativeCall<BackgroundSettings>("get_background_settings");
}

export function setBackgroundSettings(loginStart: boolean): Promise<BackgroundSettings> {
  return nativeCall<BackgroundSettings>("set_background_settings", { loginStart });
}

export function getSkillDetail(id: string): Promise<SkillDetail> {
  return call<SkillDetail>("get_skill_detail", { id });
}

/**
 * 통합 스킬 라이브러리를 읽는다. 공통 원본과 공급자별 노출 상태를 한 번에 돌려주고,
 * 파일시스템에서 매번 새로 계산하므로 별도 갱신 호출이 필요 없다.
 */
export function getSkillLibrary(): Promise<SkillLibrary> {
  return call<SkillLibrary>("get_skill_library");
}

/** 스킬·프로젝트 지침 공통 저장소의 현재 장치 설정을 읽는다. */
export function getResourceRepository(): Promise<ResourceRepositorySettings> {
  return call<ResourceRepositorySettings>("get_resource_repository");
}

/** 공통 저장소 경로를 바꾸거나 앱 데이터 내부 기본 경로로 되돌린다. */
export function setResourceRepository(
  request: SetResourceRepositoryRequest,
): Promise<ResourceRepositorySettings> {
  return call<ResourceRepositorySettings>("set_resource_repository", { request });
}

/** 세션에서 확인한 프로젝트 전체와 이 장치의 활성 여부. 스냅샷은 제외 프로젝트를 이미 걷어낸 뒤라 따로 읽는다. */
export function getProjectRegistry(): Promise<ProjectRegistryEntry[]> {
  return call<ProjectRegistryEntry[]>("get_project_registry");
}

/** 프로젝트를 제외하거나 다시 켠다. 어느 쪽이든 새 프로젝트 결정 대기는 끝난다. 갱신된 목록을 돌려준다. */
export function setProjectActive(request: SetProjectActiveRequest): Promise<ProjectRegistryEntry[]> {
  return call<ProjectRegistryEntry[]>("set_project_active", { request });
}

/** 현재 원본을 지정한 OS용으로 옮길 때 AIA가 따라야 할 정적 마이그레이션 계획. */
export function getSkillMigrationPlan(
  key: string,
  targetPlatform: HostPlatform,
): Promise<SkillMigrationPlan> {
  return call<SkillMigrationPlan>("get_skill_migration_plan", { key, targetPlatform });
}

/** 스킬 base 원본의 지원 OS 메타데이터를 낙관적 잠금으로 저장한다. */
export function setSkillPlatforms(
  request: SetSkillPlatformsRequest,
): Promise<SkillUpdateReceipt> {
  return call<SkillUpdateReceipt>("set_skill_platforms", { request });
}

export function getProjectInstructionLibrary(): Promise<ProjectInstructionLibrary> {
  return call<ProjectInstructionLibrary>("get_project_instruction_library");
}

export function getProjectInstructionMigrationPlan(
  key: string,
  targetPlatform: HostPlatform,
): Promise<ProjectInstructionMigrationPlan> {
  return call<ProjectInstructionMigrationPlan>("get_project_instruction_migration_plan", { key, targetPlatform });
}

export function readProjectInstructionFile(
  key: string,
  provider: ProviderId,
): Promise<ProjectInstructionFileContent> {
  return call<ProjectInstructionFileContent>("read_project_instruction_file", { key, provider });
}

export function createProjectInstruction(
  request: CreateProjectInstructionRequest,
): Promise<ProjectInstructionEntry> {
  return call<ProjectInstructionEntry>("create_project_instruction", { request });
}

export function importProjectInstruction(
  request: ImportProjectInstructionRequest,
): Promise<ProjectInstructionEntry> {
  return call<ProjectInstructionEntry>("import_project_instruction", { request });
}

/** 가져오기 전에 지침이 링크로 끌고 오는 문서를 훑는다. 파일을 쓰지 않는 읽기 작업이다. */
export function previewProjectInstructionImport(
  request: InstructionImportPreviewRequest,
): Promise<InstructionImportPreview> {
  return call<InstructionImportPreview>("preview_project_instruction_import", { request });
}

export function publishProjectInstruction(
  request: PublishProjectInstructionRequest,
): Promise<InstructionPublishReceipt> {
  return call<InstructionPublishReceipt>("publish_project_instruction", { request });
}

export function setProjectInstructionPlatforms(
  request: SetProjectInstructionPlatformsRequest,
): Promise<ProjectInstructionEntry> {
  return call<ProjectInstructionEntry>("set_project_instruction_platforms", { request });
}

/** 지침 삭제 전 영향 확인. 파일을 쓰지 않는 읽기 작업이다. */
export function checkProjectInstructionDelete(
  request: InstructionDeleteCheckRequest,
): Promise<InstructionDeleteImpact> {
  return call<InstructionDeleteImpact>("check_project_instruction_delete", request as Record<string, unknown>);
}

export function deleteProjectInstructionDeployment(
  scope: "personal" | "project",
  projectPath: string | null,
  provider: ProviderId,
): Promise<InstructionDeleteReceipt> {
  return call<InstructionDeleteReceipt>("delete_project_instruction_deployment", {
    request: { scope, projectPath, provider, deletedBy: "user", confirm: true },
  });
}

export function deleteSharedProjectInstruction(key: string): Promise<InstructionDeleteReceipt> {
  return call<InstructionDeleteReceipt>("delete_shared_project_instruction", {
    request: { key, deletedBy: "user", confirm: true },
  });
}

/** 보관만 취소한다. 배포된 지침 파일은 그 자리에 남고 원본만 휴지통으로 간다. */
export function unarchiveSharedProjectInstruction(key: string): Promise<InstructionDeleteReceipt> {
  return call<InstructionDeleteReceipt>("unarchive_shared_project_instruction", {
    request: { key, deletedBy: "user", confirm: true },
  });
}

/** 그 위치에 이미 있는 지침 파일을 이 원본의 배포로 등록한다. 파일은 그대로 둔다. */
export function attachProjectInstructionDeployment(
  request: InstructionDeploymentLinkRequest,
): Promise<ProjectInstructionEntry> {
  return call<ProjectInstructionEntry>("attach_project_instruction_deployment", { request });
}

/** 배포 등록만 해제한다. 파일은 그 자리에 남는다. */
export function detachProjectInstructionDeployment(
  request: InstructionDeploymentLinkRequest,
): Promise<ProjectInstructionEntry> {
  return call<ProjectInstructionEntry>("detach_project_instruction_deployment", { request });
}

export function syncProjectInstructionFromDeployment(
  request: SyncProjectInstructionRequest,
): Promise<InstructionSyncReceipt> {
  return call<InstructionSyncReceipt>("sync_project_instruction_from_deployment", { request });
}

export function updateProjectInstruction(
  request: UpdateProjectInstructionRequest,
): Promise<InstructionUpdateReceipt> {
  return call<InstructionUpdateReceipt>("update_project_instruction", { request });
}

export function setProjectInstructionAutoSync(key: string, autoSync: boolean): Promise<void> {
  return call<void>("set_project_instruction_auto_sync", { key, autoSync });
}

export function listInstructionTrash(): Promise<InstructionTrashOverview> {
  return call<InstructionTrashOverview>("list_instruction_trash");
}

export function restoreInstructionTrash(id: string): Promise<InstructionTrashRestoreReceipt> {
  return call<InstructionTrashRestoreReceipt>("restore_instruction_trash", { id });
}

export function purgeInstructionTrash(id?: string): Promise<number> {
  return call<number>("purge_instruction_trash", { id: id ?? null });
}

/** 개인 설정·프로젝트에 실제 배포된 지침 파일 원문 열람. */
export function readDeployedInstructionFile(
  scope: "personal" | "project",
  projectPath: string | null,
  provider: ProviderId,
): Promise<DeployedInstructionFileContent> {
  return call<DeployedInstructionFileContent>("read_deployed_instruction_file", {
    scope,
    projectPath,
    provider,
  });
}

/** 배포된 지침이 `@경로`로 가져오거나 링크한 문서. currentPath는 링크를 만난 문서의
 *  배포 루트 기준 상대 경로로, 비우면 지침 파일 자신을 기준으로 삼는다. */
export function getDeployedInstructionLinkedFile(
  scope: "personal" | "project",
  projectPath: string | null,
  provider: ProviderId,
  currentPath: string | null,
  href: string,
): Promise<LinkedFile> {
  return call<LinkedFile>("get_deployed_instruction_linked_file", {
    request: { scope, projectPath, provider, currentPath, href },
  });
}

/** 공통 원본의 내용 지문만 읽는 축약 조회. 스킬 변경 감지 폴링에 쓴다. */
export function getCommonSkillDigests(): Promise<CommonSkillDigest[]> {
  return call<CommonSkillDigest[]>("get_common_skill_digests");
}

/** 번들 기본 팩과 사용자가 관리하는 공통 스킬 팩을 합성한 읽기 전용 AIA 제안 카탈로그. */
export function getAiaSuggestionCatalog(): Promise<AiaSuggestionCatalog> {
  return call<AiaSuggestionCatalog>("get_aia_suggestion_catalog");
}

export interface AiaBackgroundAnalysis {
  summary: string;
  command: string | null;
}

/** 누적 대화나 시스템 도구를 쓰지 않는 호스트 전용 일회성 사건 분석. */
export function analyzeAiaEvent(eventSummary: string): Promise<AiaBackgroundAnalysis> {
  return call<AiaBackgroundAnalysis>("analyze_aia_event", { request: { eventSummary } });
}

export function getCommonSkillDetail(key: string): Promise<CommonSkillDetail> {
  return call<CommonSkillDetail>("get_common_skill_detail", { key });
}

export function createCommonSkill(request: {
  key: string;
  name?: string | null;
  description: string;
}): Promise<CommonSkillSource> {
  return call<CommonSkillSource>("create_common_skill", { request });
}

/** 공급자 사용자 스킬을 공통 원본으로 승격한다. 원본 설치본은 그대로 남는다. */
export function importSkillToCommon(skillId: string): Promise<CommonSkillSource> {
  return call<CommonSkillSource>("import_skill_to_common", { request: { skillId } });
}

export function publishCommonSkill(request: {
  key: string;
  providers: ProviderId[];
  overwrite?: SkillOverwritePolicy;
  /** 배포 위치. 생략하면 개인 루트. */
  location?: SkillLocation;
}): Promise<SkillPublishReceipt> {
  return call<SkillPublishReceipt>("publish_common_skill", { request });
}

/** 외부에서 수정된 설치본을 새 보관 원본으로 채택하고 나머지 사용 위치에 재배포한다. */
export function syncSkillFromInstall(skillId: string): Promise<SkillSyncReceipt> {
  return call<SkillSyncReceipt>("sync_skill_from_install", { request: { skillId, deletedBy: "user" } });
}

/** 외부 수정이 감지된 설치본과 보관 원본의 파일별 차이. 읽기 전용이다. */
export function compareSkillInstall(skillId: string): Promise<SkillInstallComparison> {
  return call<SkillInstallComparison>("compare_skill_install", { request: { skillId } });
}

/** 보관 원본 편집. 저장 즉시 모든 사용 위치에 재배포된다. */
export function updateCommonSkill(request: {
  key: string;
  files: SkillFileWrite[];
  deletes: string[];
  expectedDigest: string;
}): Promise<SkillUpdateReceipt> {
  return call<SkillUpdateReceipt>("update_common_skill", { request });
}

export function readCommonSkillFile(key: string, path: string): Promise<SkillFileContent> {
  return call<SkillFileContent>("read_common_skill_file", { key, path });
}

export function setSkillAutoSync(key: string, autoSync: boolean): Promise<void> {
  return call<void>("set_skill_auto_sync", { key, autoSync });
}

/** 에이전트 위치의 스킬 설치본을 확정 삭제한다. 실체는 휴지통으로 이동한다. */
export function deleteSkill(id: string): Promise<SkillDeleteReceipt> {
  return call<SkillDeleteReceipt>("delete_skill", { request: { id, deletedBy: "user", confirm: true } });
}

/** 공유 스킬을 원본과 모든 배포본까지 한 그룹으로 삭제한다. 휴지통에서 그룹 단위로 복구한다. */
export function deleteSharedSkill(key: string): Promise<SkillDeleteReceipt> {
  return call<SkillDeleteReceipt>("delete_shared_skill", { request: { key, deletedBy: "user", confirm: true } });
}

/** 보관만 취소한다. 에이전트 사용본은 그대로 남고 보관 원본만 휴지통으로 간다. */
export function unarchiveSharedSkill(key: string): Promise<SkillDeleteReceipt> {
  return call<SkillDeleteReceipt>("unarchive_shared_skill", { request: { key, deletedBy: "user", confirm: true } });
}

export function listSkillTrash(): Promise<SkillTrashOverview> {
  return call<SkillTrashOverview>("list_skill_trash");
}

/** 휴지통 항목을 원래 경로로 복구한다. 그룹에 속한 항목이면 그룹 전체를 복구한다. */
export function restoreSkillTrash(id: string): Promise<SkillTrashRestoreReceipt> {
  return call<SkillTrashRestoreReceipt>("restore_skill_trash", { id });
}

/** 휴지통 비우기. id를 생략하면 전체를 지운다. 지운 항목 수를 돌려준다. */
export function purgeSkillTrash(id?: string): Promise<number> {
  return call<number>("purge_skill_trash", { id: id ?? null });
}

export function getAgentDetail(name: string): Promise<AgentDetail> {
  return call<AgentDetail>("get_agent_detail", { name });
}

export function getArtifactDetail(
  conversationId: string,
  rootName: string,
  name: string,
): Promise<ArtifactDetail> {
  return call<ArtifactDetail>("get_artifact_detail", {
    request: { conversationId, rootName, name },
  });
}

/**
 * 사용자가 확인 대화에서 승인한 폴더 하나를 만든다. 이미 있는 상위 폴더 바로 아래 한
 * 칸만 만들고, 만든 정규 경로를 돌려준다. 호스트 UI 전용이라 원격 화면에서는 거절된다.
 */
export function createDirectory(path: string): Promise<{ path: string }> {
  return call<{ path: string }>("create_directory", { request: { path } });
}

/**
 * Antigravity 사용량. 이 공급자는 계정 레지스트리에 없어(`ProviderId::manages_accounts`)
 * 계정 목록과 함께 오지 않는다. 값은 실행 중인 language server에서 읽으므로, 회차도 IDE도
 * 돌지 않는 동안에는 status가 `idle`로 온다.
 *
 * `fresh`는 표시 캐시가 지났으면 CLI 응답을 기다리고(수십 초), `cachedFirst`는 캐시를 바로
 * 돌려주고 갱신은 뒤에서 한다. 주기적으로 폴링하는 화면은 `cachedFirst`를 써야 폴링마다
 * CLI가 뜨지 않는다.
 */
export function getAntigravityUsage(freshness: "fresh" | "cachedFirst" = "fresh"): Promise<AccountUsageView> {
  return call<AccountUsageView>("get_antigravity_usage", { freshness });
}

/**
 * Antigravity 모델군별 사용량 자원. 인증 계정이 아니라 쿼터 자원이라 계정 목록에는
 * 없지만, 모델군마다 주간·5시간 쿼터를 따로 소비하므로 계정 행과 같은 모양으로 온다.
 * 소진율 그래프가 계정과 나란히 그리고 주기 이력을 붙일 때 쓴다.
 */
export function getAntigravityPacingUsage(): Promise<ProviderAccountView[]> {
  return call<ProviderAccountView[]>("get_antigravity_pacing_usage");
}

export function getDocRoots(): Promise<DocRootStatus[]> {
  return call<DocRootStatus[]>("get_doc_roots");
}

/**
 * 문서 루트를 등록한다. `createIfMissing`은 없는 경로를 만들고 등록하라는 뜻으로,
 * 사용자가 "만들까요?" 확인에 동의했을 때만 켠다. 폴더 생성 자체는 호스트 전용이지만
 * 이 등록 경로는 원격에서도 열려 있다.
 */
export function createDocRoot(name: string, path: string, createIfMissing = false): Promise<DocRootStatus> {
  return call<DocRootStatus>("create_doc_root", { request: { name, path, createIfMissing } });
}

export function deleteDocRoot(id: string): Promise<void> {
  return call<void>("delete_doc_root", { id });
}

export function listDocumentEntries(
  rootId: string,
  parentPath = "",
  cursor: string | null = null,
  limit = 200,
): Promise<DocumentEntryPage> {
  return call<DocumentEntryPage>("list_document_entries", { rootId, parentPath, cursor, limit });
}

export function searchDocumentEntries(
  rootId: string,
  query: string,
  cursor: string | null = null,
  limit = 200,
): Promise<DocumentEntryPage> {
  return call<DocumentEntryPage>("search_document_entries", { rootId, query, cursor, limit });
}

export function getDocumentFile(rootId: string, relativePath: string): Promise<DocumentFile> {
  return call<DocumentFile>("get_document_file", { rootId, relativePath });
}

export function getDocumentAutomationSnapshot(): Promise<DocumentAutomationSnapshot> {
  return call<DocumentAutomationSnapshot>("get_document_automation_snapshot");
}

export function createDocumentTrigger(request: DocumentTriggerInput): Promise<DocumentTrigger> {
  return call<DocumentTrigger>("create_document_trigger", { request });
}

export function updateDocumentTrigger(id: string, input: DocumentTriggerInput): Promise<DocumentTrigger> {
  return call<DocumentTrigger>("update_document_trigger", { id, input });
}

export function deleteDocumentTrigger(id: string): Promise<void> {
  return call<void>("delete_document_trigger", { id });
}

export function setDocumentTriggerEnabled(id: string, enabled: boolean): Promise<DocumentTrigger> {
  return call<DocumentTrigger>("set_document_trigger_enabled", { id, enabled });
}

export function runDocumentTriggerTest(id: string): Promise<DocumentTriggerRun> {
  return call<DocumentTriggerRun>("run_document_trigger_test", { id });
}

export function acknowledgeDocumentOfflineReport(id: string): Promise<void> {
  return call<void>("acknowledge_document_offline_report", { id });
}

export function getSystemWorkflows(): Promise<SystemWorkflowList> {
  return call<SystemWorkflowList>("get_system_workflows");
}

export function getSystemWorkflow(workflowId: string): Promise<SystemWorkflowDetail> {
  return call<SystemWorkflowDetail>("get_system_workflow", { workflowId });
}

export function deleteSystemWorkflow(workflowId: string): Promise<unknown> {
  return call<unknown>("delete_system_workflow", { workflowId });
}

/**
 * 워크플로 하나를 사용량 페이싱 대상으로 켜거나 끈다. 갱신된 목록을 그대로 돌려주므로
 * 화면은 한 번의 왕복으로 토글과 배지를 다시 그린다.
 */
export function setSystemWorkflowPacing(request: SetSystemWorkflowPacingRequest): Promise<SystemWorkflowList> {
  return call<SystemWorkflowList>("set_system_workflow_pacing", { request });
}

/**
 * 워크플로를 실행한다. `idempotencyKey`는 같은 실행을 두 번 보내지 않기 위한 것이라
 * 재시도할 때도 같은 값을 유지해야 한다. `expectedVersion`을 주면 그 버전만 실행한다.
 */
export function executeSystemWorkflow(
  workflowId: string,
  idempotencyKey: string,
  args: Record<string, unknown> = {},
  expectedVersion?: number,
): Promise<SystemWorkflowExecution> {
  return call<SystemWorkflowExecution>("execute_system_workflow", {
    workflowId,
    arguments: args,
    idempotencyKey,
    expectedVersion: expectedVersion ?? null,
  });
}

export function getDocLinkedFile(
  rootId: string,
  currentPath: string,
  href: string,
): Promise<LinkedFile> {
  return call<LinkedFile>("get_doc_linked_file", { request: { rootId, currentPath, href } });
}

export function putDoc(
  rootId: string,
  relativePath: string,
  content: string,
  expectedModifiedAt: number | null,
): Promise<DocFile> {
  return call<DocFile>("put_doc", {
    request: { rootId, relativePath, content, expectedModifiedAt },
  });
}

// ---- Cypress 자동화 작업공간 ----
// 등록·설치·실행·민감 파일 쓰기는 호스트 전용이라 원격 접속에서는 403이 난다.

/** Cypress 모듈 설치는 npm 다운로드·바이너리 설치까지 최대 15분쯤 걸릴 수 있다. */
const CYPRESS_INSTALL_TIMEOUT_MS = 20 * 60 * 1000;

export function getCypressRegistry(): Promise<CypressRegistry> {
  return call<CypressRegistry>("get_cypress_registry");
}

export function setCypressEnabled(enabled: boolean): Promise<CypressRegistry> {
  return call<CypressRegistry>("set_cypress_enabled", { enabled });
}

export function addCypressWorkspace(name: string, path: string, moduleDir: string | null = null): Promise<CypressRegistry> {
  return call<CypressRegistry>("add_cypress_workspace", { name, path, moduleDir });
}

export function removeCypressWorkspace(id: string): Promise<CypressRegistry> {
  return call<CypressRegistry>("remove_cypress_workspace", { id });
}

export function installCypressModule(id: string, version: string | null = null): Promise<CypressInstallReceipt> {
  return call<CypressInstallReceipt>("install_cypress_module", { id, version }, { timeoutMs: CYPRESS_INSTALL_TIMEOUT_MS });
}

export function listCypressWorkspaceFiles(id: string): Promise<CypressWorkspaceFile[]> {
  return call<CypressWorkspaceFile[]>("list_cypress_workspace_files", { id });
}

/** 민감 파일(cypress.env.json)은 여기서 항상 `masked: true`(값이 "•••"인 JSON)로 온다. 원문은 `readCypressEnvFile`. */
export function readCypressWorkspaceFile(id: string, path: string): Promise<CypressWorkspaceFileContent> {
  return call<CypressWorkspaceFileContent>("read_cypress_workspace_file", { id, path });
}

/** 민감 파일 경로는 거절된다. 그 파일은 `writeCypressEnvFile`로만 쓴다. */
export function writeCypressWorkspaceFile(id: string, path: string, content: string): Promise<CypressWorkspaceFile> {
  return call<CypressWorkspaceFile>("write_cypress_workspace_file", { id, path, content });
}

/** cypress.env.json 원문(호스트 전용). 원격 접속은 403이 나므로 마스킹본을 대신 보인다. */
export function readCypressEnvFile(id: string): Promise<CypressWorkspaceFileContent> {
  return call<CypressWorkspaceFileContent>("read_cypress_env_file", { id });
}

/** cypress.env.json 저장(호스트 전용). */
export function writeCypressEnvFile(id: string, content: string): Promise<CypressWorkspaceFile> {
  return call<CypressWorkspaceFile>("write_cypress_env_file", { id, content });
}

export function deleteCypressWorkspaceFile(id: string, path: string): Promise<null> {
  return call<null>("delete_cypress_workspace_file", { id, path });
}

export function runCypressSpec(id: string, spec: string | null = null, env: Record<string, string> | null = null): Promise<CypressRunStatus> {
  return call<CypressRunStatus>("run_cypress_spec", { id, spec, env });
}

export function getCypressRunStatus(jobId: string): Promise<CypressRunStatus> {
  return call<CypressRunStatus>("get_cypress_run_status", { jobId });
}

/** 최근 실행부터 돌려준다. */
export function listCypressRuns(): Promise<CypressRunStatus[]> {
  return call<CypressRunStatus[]>("list_cypress_runs");
}
