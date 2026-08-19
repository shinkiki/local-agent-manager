import { invoke } from "@tauri-apps/api/core";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import type {
  AgentDetail,
  AccountLoginSessionView,
  AccountSnapshot,
  AppStatus,
  ArtifactDetail,
  BackgroundSettings,
  ChatAttentionSnapshot,
  ChatProfile,
  ChatSessionInfo,
  ChatProviderOptions,
  DocFile,
  DocRootStatus,
  ExternalProviderProcess,
  FileNode,
  LinkedFile,
  ManagerSnapshot,
  MenuTranslations,
  ProviderId,
  SessionDetail,
  SessionCatalogUpdate,
  SessionFolder,
  SessionMeta,
  SessionMetaPatch,
  SessionSummary,
  SessionTranscriptLimit,
  StopProviderChatsReport,
  StorageOverview,
  SwitchActiveProviderAccountReceipt,
  SystemAutomationSettingsInput,
  SystemAutomationSnapshot,
  SystemLanguageRequest,
  SourceCounts,
  SourceTotals,
  ScheduledRequest,
  ScheduledRequestInput,
  SchedulerSnapshot,
  ScheduledRunCancellationReceipt,
  ProviderTransitionRecoveryReceipt,
  CancelAndRecoverScheduledRunReceipt,
  SkillDetail,
  TranslatedDetail,
  TranslationMenu,
} from "../types";
import {
  assertBackendStoreIdentity,
  backendHttpUrl,
  currentBackendServicePort,
  currentBackendStoreId,
  hasNativeShell,
  LEGACY_BACKEND_SERVICE_PORT,
  setBackendServiceIdentity,
  validBackendStoreId,
  validBackendServicePort,
} from "./backend";

const EXPECTED_BACKEND_PROTOCOL_VERSION = 3;

export function hasTauriRuntime(): boolean {
  return hasNativeShell();
}

/** 단일 백엔드까지 요청이 도달하지 못한 네트워크 수준 실패. */
export class RemoteConnectionError extends Error {
  readonly cause: unknown;

  constructor(cause: unknown) {
    super("Agent Manager 백엔드 서비스에 연결하지 못했습니다. 서비스가 실행 중인지 확인하세요.");
    this.name = "RemoteConnectionError";
    this.cause = cause;
  }
}

async function remoteFetch(input: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(input, init);
  } catch (cause) {
    throw new RemoteConnectionError(cause);
  }
}

async function call<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  await ensureBackendProtocol();
  const response = await remoteFetch(backendHttpUrl(`/api/invoke/${encodeURIComponent(command)}`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  const payload = await response.json().catch(() => null) as { error?: string } | T | null;
  if (!response.ok) {
    const message = payload && typeof payload === "object" && "error" in payload
      ? payload.error
      : null;
    throw new Error(message || `원격 요청에 실패했습니다 (${response.status})`);
  }
  return payload as T;
}

function nativeCall<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  if (!hasNativeShell()) {
    return Promise.reject(new Error("이 기능은 데스크톱 앱에서만 사용할 수 있습니다."));
  }
  return invoke<T>(command, args);
}

export interface BackendServiceSettings {
  port: number;
  storeId: string;
}

export async function getBackendServiceSettings(): Promise<BackendServiceSettings> {
  return validatedBackendServiceSettings(
    await nativeCall<BackendServiceSettings>("get_backend_service_settings"),
  );
}

async function getActiveBackendServiceSettings(): Promise<BackendServiceSettings> {
  return validatedBackendServiceSettings(
    await nativeCall<BackendServiceSettings>("get_active_backend_service_settings"),
  );
}

export async function setBackendServiceSettings(port: number): Promise<BackendServiceSettings> {
  validBackendServicePort(port);
  return validatedBackendServiceSettings(
    await nativeCall<BackendServiceSettings>("set_backend_service_settings", { port }),
  );
}

export function showNativeNotification(title: string, body: string): Promise<void> {
  return nativeCall<void>("show_native_notification", { title, body });
}

/** React가 도메인 API를 호출하기 전에 데스크톱 서비스 주소를 확정합니다. */
export async function initializeBackendService(): Promise<BackendServiceSettings | null> {
  if (!hasNativeShell()) return null;
  const configured = await getActiveBackendServiceSettings();
  setBackendServiceIdentity(configured.port, configured.storeId);
  backendProtocolHandshake = null;
  try {
    await waitForBackendProtocol(40, 125);
    return configured;
  } catch (cause) {
    // A persisted custom port can outlive an externally managed service that
    // still owns this store on the legacy deployment port. Reuse that port only
    // for a network-level miss and only after its stable storeId matches.
    if (!(cause instanceof RemoteConnectionError)
      || configured.port === LEGACY_BACKEND_SERVICE_PORT) {
      throw cause;
    }
    setBackendServiceIdentity(LEGACY_BACKEND_SERVICE_PORT, configured.storeId);
    backendProtocolHandshake = null;
    try {
      await waitForBackendProtocol(8, 125);
      return { ...configured, port: LEGACY_BACKEND_SERVICE_PORT };
    } catch (fallbackCause) {
      setBackendServiceIdentity(configured.port, configured.storeId);
      backendProtocolHandshake = null;
      if (!(fallbackCause instanceof RemoteConnectionError)) throw fallbackCause;
      throw cause;
    }
  }
}

async function waitForBackendProtocol(attempts: number, delayMs: number): Promise<WebAccessStatus> {
  let lastError: RemoteConnectionError | null = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await ensureBackendProtocol();
    } catch (cause) {
      if (!(cause instanceof RemoteConnectionError)) throw cause;
      lastError = cause;
      if (attempt + 1 < attempts) {
        await new Promise<void>((resolve) => window.setTimeout(resolve, delayMs));
      }
    }
  }
  throw lastError ?? new RemoteConnectionError("응답 없음");
}

function validatedBackendServiceSettings(settings: BackendServiceSettings): BackendServiceSettings {
  if (!settings || typeof settings !== "object") {
    throw new Error("백엔드 서비스 설정 응답이 올바르지 않습니다.");
  }
  return {
    port: validBackendServicePort(settings.port),
    storeId: validBackendStoreId(settings.storeId),
  };
}

export interface WebAccessStatus {
  protocolVersion: number;
  storeId: string;
  backendPort: number;
  mode: "local" | "tailscale";
  remote: boolean;
  writable: boolean;
}

let backendProtocolHandshake: Promise<WebAccessStatus> | null = null;

function ensureBackendProtocol(): Promise<WebAccessStatus> {
  if (!backendProtocolHandshake) {
    backendProtocolHandshake = getWebAccessStatus().catch((cause) => {
      backendProtocolHandshake = null;
      throw cause;
    });
  }
  return backendProtocolHandshake;
}

export async function getWebAccessStatus(): Promise<WebAccessStatus> {
  const response = await remoteFetch(backendHttpUrl("/api/access"), {
    cache: "no-store",
    headers: { Accept: "application/json" },
  });
  const payload = await response.json().catch(() => null) as
    | (Partial<WebAccessStatus> & { error?: string })
    | null;
  if (!response.ok) {
    throw new Error(payload?.error || `원격 접근 상태를 확인하지 못했습니다 (${response.status})`);
  }
  if (payload?.protocolVersion !== EXPECTED_BACKEND_PROTOCOL_VERSION) {
    throw new Error(`백엔드 서버 API 버전이 호환되지 않습니다 (필요 ${EXPECTED_BACKEND_PROTOCOL_VERSION}, 응답 ${String(payload?.protocolVersion ?? "없음")}). 서버를 최신 빌드로 다시 시작하세요.`);
  }
  if ((payload.mode !== "local" && payload.mode !== "tailscale")
    || typeof payload.remote !== "boolean" || typeof payload.writable !== "boolean") {
    throw new Error("원격 접근 상태 응답이 올바르지 않습니다.");
  }
  const expectedStoreId = hasNativeShell() ? currentBackendStoreId() : null;
  if (hasNativeShell() && expectedStoreId === null) {
    throw new Error("백엔드 서비스 저장소 식별자가 초기화되지 않았습니다.");
  }
  const storeId = assertBackendStoreIdentity(payload.storeId, expectedStoreId);
  const backendPort = payload.backendPort === undefined
    ? payload.mode === "tailscale"
      ? LEGACY_BACKEND_SERVICE_PORT
      : currentBackendServicePort() ?? LEGACY_BACKEND_SERVICE_PORT
    : validBackendServicePort(payload.backendPort);
  return {
    protocolVersion: payload.protocolVersion,
    storeId,
    backendPort,
    mode: payload.mode,
    remote: payload.remote,
    writable: payload.writable,
  };
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

async function downloadLinkedFile(
  endpoint: "session" | "chat" | "doc",
  request: Record<string, unknown>,
  href: string,
): Promise<void> {
  const fallbackName = linkedFileName(href);
  const response = await remoteFetch(backendHttpUrl(`/api/download/linked-file/${endpoint}`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ request }),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(payload?.error || `파일 다운로드에 실패했습니다 (${response.status})`);
  }
  const fileName = responseFileName(response.headers.get("Content-Disposition")) ?? fallbackName;
  if (hasNativeShell()) {
    const destination = await saveDialog({
      title: "링크 파일 저장",
      defaultPath: fileName,
    });
    if (!destination) return;
    await invoke<void>(
      "save_downloaded_linked_file",
      new Uint8Array(await response.arrayBuffer()),
      {
        headers: {
          "x-destination": encodeURIComponent(destination),
          "x-relative-path": encodeURIComponent(fileName),
        },
      },
    );
    return;
  }

  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

function linkedFileName(href: string): string {
  let target = href.trim().replace(/^<|>$/g, "").split(/[?#]/, 1)[0].replace(/:\d+$/, "");
  try { target = decodeURIComponent(target); } catch { /* Keep the encoded fallback. */ }
  const name = target.replace(/\\/g, "/").split("/").filter(Boolean).pop();
  return sanitizeDownloadName(name || "download");
}

function responseFileName(disposition: string | null): string | null {
  if (!disposition) return null;
  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (encoded) {
    try { return sanitizeDownloadName(decodeURIComponent(encoded)); } catch { /* Use fallback. */ }
  }
  const fallback = disposition.match(/filename="([^"]+)"/i)?.[1];
  return fallback ? sanitizeDownloadName(fallback) : null;
}

function sanitizeDownloadName(name: string): string {
  const safe = name.replace(/[\\/\0]/g, "_").trim();
  return safe && safe !== "." && safe !== ".." ? safe : "download";
}

export function getAppStatus(): Promise<AppStatus> {
  return call<AppStatus>("get_app_status");
}

export function getProviderAccounts(): Promise<AccountSnapshot> {
  return call<AccountSnapshot>("get_provider_accounts");
}

export function registerCurrentProviderAccount(
  source: ProviderId,
  displayName?: string | null,
): Promise<AccountSnapshot> {
  return call<AccountSnapshot>("register_current_provider_account", { source, displayName });
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

export function setDefaultProviderAccount(accountId: string): Promise<AccountSnapshot> {
  return call<AccountSnapshot>("set_default_provider_account", { accountId });
}

export function setActiveProviderAccount(accountId: string): Promise<AccountSnapshot> {
  return call<AccountSnapshot>("set_active_provider_account", { accountId });
}

export function stopProviderChats(provider: ProviderId): Promise<StopProviderChatsReport> {
  return call<StopProviderChatsReport>("stop_provider_chats", { provider });
}

export function listExternalProviderProcesses(
  provider: ProviderId,
): Promise<ExternalProviderProcess[]> {
  return call<ExternalProviderProcess[]>("list_external_provider_processes", { provider });
}

export function switchActiveProviderAccount(
  accountId: string,
  stopRunningChats: boolean,
  stopExternalProcesses: boolean,
): Promise<SwitchActiveProviderAccountReceipt> {
  return call<SwitchActiveProviderAccountReceipt>("switch_active_provider_account", {
    accountId,
    stopRunningChats,
    stopExternalProcesses,
  });
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

export function setAutoSwitchResume(enabled: boolean): Promise<AccountSnapshot> {
  return call<AccountSnapshot>("set_auto_switch_resume", { enabled });
}

export function deleteProviderAccount(accountId: string): Promise<AccountSnapshot> {
  return call<AccountSnapshot>("delete_provider_account", { accountId });
}

export function refreshProviderAccountUsage(accountId: string): Promise<AccountSnapshot> {
  return call<AccountSnapshot>("refresh_provider_account_usage", { accountId });
}

export function revalidateProviderAccountCredential(accountId: string): Promise<AccountSnapshot> {
  return call<AccountSnapshot>("revalidate_provider_account_credential", { accountId });
}

export function getManagerSnapshot(): Promise<ManagerSnapshot> {
  return call<ManagerSnapshot>("get_manager_snapshot").then(normalizeManagerSnapshot);
}

export function reconcileSessionCatalog(): Promise<SessionCatalogUpdate> {
  return call<SessionCatalogUpdate>("reconcile_session_catalog");
}

export function refreshSessionCatalog(
  source: ProviderId,
  id: string,
): Promise<SessionCatalogUpdate> {
  return call<SessionCatalogUpdate>("refresh_session_catalog", { request: { source, id } });
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

export function getDetachedChatForSession(
  source: ProviderId,
  id: string,
): Promise<ChatSessionInfo | null> {
  return call<ChatSessionInfo | null>("get_detached_chat_for_session", { request: { source, id } });
}

export function getLiveChats(profile: ChatProfile = "standard"): Promise<ChatSessionInfo[]> {
  return call<ChatSessionInfo[]>("get_live_chats", { profile });
}

export function markChatAttentionRead(id: string): Promise<ChatAttentionSnapshot> {
  return call<ChatAttentionSnapshot>("mark_chat_attention_read", { id });
}

export function markAllChatAttentionRead(): Promise<ChatAttentionSnapshot> {
  return call<ChatAttentionSnapshot>("mark_all_chat_attention_read");
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

export function getSessionLinkedFile(
  source: ProviderId,
  id: string,
  href: string,
): Promise<LinkedFile> {
  return call<LinkedFile>("get_session_linked_file", { request: { source, id, href } });
}

export function downloadSessionLinkedFile(
  source: ProviderId,
  id: string,
  href: string,
): Promise<void> {
  return downloadLinkedFile("session", { source, id, href }, href);
}

export function getChatLinkedFile(chatId: string, href: string): Promise<LinkedFile> {
  return call<LinkedFile>("get_chat_linked_file", { request: { chatId, href } });
}

export function downloadChatLinkedFile(chatId: string, href: string): Promise<void> {
  return downloadLinkedFile("chat", { chatId, href }, href);
}

export function patchSessionMeta(
  source: ProviderId,
  id: string,
  patch: SessionMetaPatch,
): Promise<SessionMeta> {
  return call<SessionMeta>("patch_session_meta", { request: { source, id, patch } });
}

export function getSessionFolders(): Promise<SessionFolder[]> {
  return call<SessionFolder[]>("get_session_folders");
}

export function createSessionFolder(name: string, color: string): Promise<SessionFolder> {
  return call<SessionFolder>("create_session_folder", { request: { name, color } });
}

export function updateSessionFolder(
  id: string,
  patch: { name?: string; color?: string },
): Promise<SessionFolder> {
  return call<SessionFolder>("update_session_folder", { request: { id, ...patch } });
}

export function deleteSessionFolder(id: string): Promise<void> {
  return call<void>("delete_session_folder", { id });
}

export function getSchedulerSnapshot(): Promise<SchedulerSnapshot> {
  return call<SchedulerSnapshot>("get_scheduler_snapshot");
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

export function recoverProviderTransition(request: { provider: ProviderId; runId: string; transitionId: string }): Promise<ProviderTransitionRecoveryReceipt> {
  return call<ProviderTransitionRecoveryReceipt>("recover_provider_transition", request);
}

export function cancelAndRecoverScheduledRun(
  request: { provider: ProviderId; runId: string; transitionId: string },
  reason?: string,
): Promise<CancelAndRecoverScheduledRunReceipt> {
  return call<CancelAndRecoverScheduledRunReceipt>("cancel_and_recover_scheduled_run", { request, reason });
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

export function getDocRoots(): Promise<DocRootStatus[]> {
  return call<DocRootStatus[]>("get_doc_roots");
}

export function createDocRoot(name: string, path: string): Promise<DocRootStatus> {
  return call<DocRootStatus>("create_doc_root", { request: { name, path } });
}

export function deleteDocRoot(id: string): Promise<void> {
  return call<void>("delete_doc_root", { id });
}

export function getDocTree(rootId: string): Promise<FileNode[]> {
  return call<FileNode[]>("get_doc_tree", { rootId });
}

export function getDoc(rootId: string, relativePath: string): Promise<DocFile> {
  return call<DocFile>("get_doc", { request: { rootId, relativePath } });
}

export function getDocLinkedFile(
  rootId: string,
  currentPath: string,
  href: string,
): Promise<LinkedFile> {
  return call<LinkedFile>("get_doc_linked_file", { request: { rootId, currentPath, href } });
}

export function downloadDocLinkedFile(
  rootId: string,
  currentPath: string,
  href: string,
): Promise<void> {
  return downloadLinkedFile(
    "doc",
    { rootId, currentPath, href },
    href,
  );
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
