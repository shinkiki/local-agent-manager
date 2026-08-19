export type ProviderId = "claude" | "codex" | "antigravity";
export type ViewId = "dashboard" | "chat" | "sessions" | "docs" | "skills" | "agents" | "artifacts" | "storage" | "settings";
export type MessageDisplayMode = "start" | "latest";
export type ThemeMode = "auto" | "light" | "dark";
export type AccentColor = "brass" | "green" | "blue" | "cyan" | "violet";
export type AppLocale = string;
export type TranslationMenu = "skills" | "agents" | "artifacts";

export interface TranslationLanguage {
  code: string;
  name: string;
}

export interface DetectedResource {
  detected: boolean;
  path: string | null;
}

export interface ProviderStatus {
  provider: ProviderId;
  displayName: string;
  cli: DetectedResource;
  history: DetectedResource;
}

export interface AppStatus {
  schemaVersion: number;
  platform: string;
  architecture: string;
  providers: ProviderStatus[];
}

export type AccountAuthStatus = "ready" | "missing" | "error";
export type AccountUsageStatus = "idle" | "ok" | "unavailable" | "error";

export interface AccountUsageWindow {
  label: string;
  usedPercent: number;
  resetsAt: number | null;
}

export interface AccountUsageView {
  status: AccountUsageStatus;
  windows: AccountUsageWindow[];
  updatedAt: number | null;
  error: string | null;
  retryAt?: number | null;
  rateLimited?: boolean;
}

export interface ProviderAccountView {
  id: string;
  provider: ProviderId;
  displayName: string;
  email: string | null;
  organization: string | null;
  providerAccountId: string;
  isActive: boolean;
  isDefault: boolean;
  isPendingDefault: boolean;
  disabled: boolean;
  autoSwitch: boolean;
  authStatus: AccountAuthStatus;
  usage: AccountUsageView;
}

export type AutoSwitchReason = "usageExhausted" | "agentLimited";

export interface AutoSwitchEventView {
  fromAccountId: string;
  toAccountId: string;
  reason: AutoSwitchReason;
  at: number;
  /** 전환 직후 resume으로 재시작한 채팅 세션 수 */
  resumedSessionCount: number;
}

export interface ProviderAccountStateView {
  provider: ProviderId;
  defaultAccountId: string | null;
  activeAccountId: string | null;
  /** 공유 CLI 홈에서 실제로 확인된 등록 계정. 알 수 없거나 미등록이면 null. */
  observedActiveAccountId: string | null;
  pendingDefaultAccountId: string | null;
  runtimeCount: number;
  transitionInProgress: boolean;
  transition: ProviderAccountTransitionView | null;
  recoveryError: string | null;
  lastAutoSwitch: AutoSwitchEventView | null;
}

export interface ProviderAccountTransitionView {
  provider: ProviderId;
  transitionId: string;
  previousActiveAccountId: string;
  targetAccountId: string;
  runtimeCount: number;
  phase: string;
}

export interface AccountSnapshot {
  accounts: ProviderAccountView[];
  providers: ProviderAccountStateView[];
  /** 자동전환으로 종료된 실행 중 채팅을 새 계정에서 resume으로 재시작할지 여부 */
  autoSwitchResume: boolean;
}

export interface StopChatFailure {
  chatId: string;
  error: string;
}

export interface StopTerminalFailure {
  terminalId: string;
  sessionId: string;
  error: string;
}

/** Agent Manager 밖에서 독립 실행 중인 공급자 CLI 프로세스 */
export interface ExternalProviderProcess {
  pid: number;
  command: string;
}

export interface ExternalProcessFailure {
  pid: number;
  command: string;
  error: string;
}

export interface StopProviderChatsReport {
  provider: ProviderId;
  requestedCount: number;
  stoppedCount: number;
  /** 정상 종료가 실패해 강제 종료로 승격된 세션 수(stoppedCount에 포함) */
  forcedCount: number;
  failed: StopChatFailure[];
  terminalRequestedCount: number;
  terminalStoppedCount: number;
  /** 정상 종료가 실패해 강제 종료로 승격된 터미널 수(terminalStoppedCount에 포함) */
  terminalForcedCount: number;
  terminalFailed: StopTerminalFailure[];
  remainingTerminalCount: number;
  remainingRuntimeCount: number;
}

export interface SwitchActiveProviderAccountReceipt {
  provider: ProviderId;
  previousAccountId: string | null;
  targetAccountId: string;
  activeAccountId: string | null;
  requestedCount: number;
  stoppedCount: number;
  /** 정상 종료가 실패해 강제 종료로 승격된 세션 수(stoppedCount에 포함) */
  forcedCount: number;
  failed: StopChatFailure[];
  terminalRequestedCount: number;
  terminalStoppedCount: number;
  /** 정상 종료가 실패해 강제 종료로 승격된 터미널 수(terminalStoppedCount에 포함) */
  terminalForcedCount: number;
  terminalFailed: StopTerminalFailure[];
  remainingTerminalCount: number;
  remainingRuntimeCount: number;
  /** 종료 대상이 된 외부 독립 실행 공급자 CLI 프로세스 수 */
  externalRequestedCount: number;
  externalTerminatedCount: number;
  /** SIGTERM이 실패해 강제 종료로 승격된 외부 프로세스 수(externalTerminatedCount에 포함) */
  externalForcedCount: number;
  /** 강제 종료까지 실패한 외부 프로세스(계정 전환은 막지 않음) */
  externalFailed: ExternalProcessFailure[];
  usageRefreshed: boolean;
  snapshot: AccountSnapshot;
}

export interface AccountLoginSessionView {
  id: string;
  provider: ProviderId;
  accountId: string | null;
  environmentVariable: string;
  profilePath: string;
  command: string;
}

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface SessionMeta {
  favorite: boolean;
  hidden: boolean;
  note: string | null;
  customTitle: string | null;
  folderIds: string[];
  reasoningEffort: ReasoningEffort | null;
  mode: ChatMode | null;
  approvalMode: ChatApprovalMode | null;
  creationAccountId: string | null;
}

export interface SessionMetaPatch {
  favorite?: boolean;
  hidden?: boolean;
  note?: string | null;
  customTitle?: string | null;
  folderIds?: string[];
}

export interface SessionFolder {
  id: string;
  name: string;
  color: string;
  sortOrder: number;
  parentId?: string;
  sessionCount: number;
}

export interface SessionSummary {
  source: ProviderId;
  id: string;
  title: string;
  sourceTitle: string | null;
  project: string | null;
  cwd: string | null;
  startedAt: number | null;
  updatedAt: number | null;
  messageCount: number | null;
  tokenTotal: number | null;
  tokenUsage: TokenUsage | null;
  model: string | null;
  gitBranch: string | null;
  isSubagent: boolean;
  archived: boolean;
  readable: boolean;
  sizeBytes: number | null;
  filePath: string;
  meta: SessionMeta;
}

export interface LinkedFile {
  relativePath: string;
  content: string;
  sizeBytes: number;
  targetLine: number | null;
}

export interface ProjectOption {
  name: string;
  path: string;
  count: number;
  updatedAt: number;
}

export interface ModelOption {
  source: ProviderId;
  model: string;
  count: number;
  updatedAt: number;
}

export interface SourceCounts {
  claude: number;
  codex: number;
  antigravity: number;
}

export interface SourceTotals extends SourceCounts {
  total: number;
}

export interface DashboardStats {
  sessionCount: number;
  sessionsBySource: SourceCounts;
  tokens: SourceTotals;
  disk: SourceTotals;
  skillCount: number;
  agentCount: number;
  models: { model: string; count: number }[];
  topProjects: { name: string; path: string; count: number }[];
  weekly: { weekStart: number; claude: number; codex: number; antigravity: number }[];
  recent: SessionSummary[];
}

export interface SkillSummary {
  id: string;
  source: ProviderId;
  scope: "personal" | "project" | "plugin" | "system" | "builtin" | string;
  name: string;
  description: string;
  path: string;
  directory: string;
  origin: string | null;
}

export interface FileNode {
  name: string;
  relativePath: string;
  sizeBytes: number;
  isDirectory: boolean;
  children: FileNode[];
}

export interface SkillDetail {
  skill: SkillSummary;
  body: string;
  files: FileNode[];
}

export interface AgentDefinition {
  name: string;
  description: string;
  tools: string[];
  model: string | null;
  maxTurns: number | null;
  permissionMode: string | null;
  skills: string[];
  path: string;
}

export interface AgentDetail {
  definition: AgentDefinition;
  body: string;
}

export interface ArtifactSummary {
  conversationId: string;
  rootName: string;
  name: string;
  artifactType: string | null;
  summary: string | null;
  updatedAt: number | null;
  version: number | null;
  versions: number[];
  sizeBytes: number;
}

export interface ArtifactGroup {
  conversationId: string;
  rootName: string;
  title: string | null;
  readable: boolean;
  artifacts: ArtifactSummary[];
  imageCount: number;
}

export interface ArtifactDetail {
  artifact: ArtifactSummary;
  content: string;
}

export type ContentBlock =
  | { kind: "text"; text: string }
  | { kind: "context"; label: string; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool_use"; name: string; inputJson: string }
  | { kind: "tool_result"; text: string; isError: boolean }
  | {
      kind: "session_info";
      id: string | null;
      cwd: string | null;
      originator: string | null;
      cliVersion: string | null;
      source: string | null;
      modelProvider: string | null;
      threadSource: string | null;
      historyMode: string | null;
      contextWindowId: string | null;
      toolCount: number;
      rawJson: string;
      rawTruncated: boolean;
    }
  | { kind: "raw"; json: string };

export interface TranscriptItem {
  index: number;
  turnId?: string | null;
  role: "user" | "assistant" | "system" | "meta" | string;
  timestamp: number | null;
  model: string | null;
  typeLabel: string | null;
  blocks: ContentBlock[];
  usage: TokenUsage | null;
}

export interface SessionDetail {
  session: SessionSummary;
  transcript: TranscriptItem[];
  truncated: boolean;
  skippedLines: number;
  unavailableReason: string | null;
}

export type SessionTranscriptLimit = "latest100" | "latest500" | "latest1000" | "all";

export type TerminalPhase = "running" | "detached" | "stopping" | "exited" | "failed";

export interface TerminalOpenRequest {
  source: ProviderId;
  sessionId: string;
  cols: number;
  rows: number;
}

export interface TerminalSetupRequest {
  source: ProviderId;
  cols: number;
  rows: number;
}

export interface TerminalAccountLoginRequest {
  loginId: string;
  cols: number;
  rows: number;
}

export interface TerminalSessionInfo {
  terminalId: string;
  source: ProviderId;
  sessionId: string;
  state: TerminalPhase;
  reconnectDeadline: number | null;
  exitCode: number | null;
  replayTruncated: boolean;
}

export type TerminalEvent =
  | { type: "output"; data: number[] | Uint8Array }
  | { type: "state"; session: TerminalSessionInfo }
  | { type: "exit"; code: number | null }
  | { type: "error"; message: string };

export type ChatMode = "plan" | "workspace" | "fullAccess";
export type ChatApprovalMode = "manual" | "autoReview" | "never";
export type ChatProfile = "standard" | "aia";
export type ChatPhase = "ready" | "running" | "waitingApproval" | "stopped" | "failed";
export type ChatApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel";
export type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

export interface ChatReasoningOption {
  effort: ReasoningEffort;
  description: string;
}

export interface ChatModelCatalogOption {
  model: string;
  displayName: string;
  description: string;
  isDefault: boolean;
  defaultReasoningEffort: ReasoningEffort | null;
  supportedReasoningEfforts: ChatReasoningOption[];
}

export type ChatSettingFieldKind = "enum" | "text";

export interface ChatSettingOption {
  value: string;
  label: string;
  detail?: string | null;
  disabled?: boolean;
}

export interface ChatSettingField {
  key: string;
  label: string;
  detail?: string | null;
  kind: ChatSettingFieldKind;
  options: ChatSettingOption[];
  defaultValue?: string | null;
}

export interface ChatProviderOptions {
  source: ProviderId;
  models: ChatModelCatalogOption[];
  supportedReasoningEfforts: ChatReasoningOption[];
  defaultReasoningEffort: ReasoningEffort | null;
  catalogError: string | null;
  settings: ChatSettingField[];
  settingsUpdatedAt: number | null;
}

export interface ChatStartRequest {
  source: ProviderId;
  accountId?: string | null;
  cwd: string;
  model: string | null;
  reasoningEffort?: ReasoningEffort | null;
  mode: ChatMode;
  approvalMode: ChatApprovalMode;
  resumeSessionId?: string | null;
  unattended?: boolean;
  profile?: ChatProfile;
  settings?: Record<string, string>;
}

export interface ChatSessionInfo {
  chatId: string;
  startedAt: number;
  source: ProviderId;
  accountId: string | null;
  resuming: boolean;
  providerSessionId: string | null;
  cwd: string;
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
  mode: ChatMode;
  approvalMode: ChatApprovalMode;
  state: ChatPhase;
  turnCount: number;
  lastTurnStatus: string | null;
  unattended: boolean;
  attached: boolean;
  interactiveApprovals: boolean;
  profile: ChatProfile;
  /** AIA 런타임이 aia_system MCP를 붙였는지. false면 시스템 도구 없이 대화만 가능하다. */
  systemTools: boolean;
  settings?: Record<string, string>;
}

export interface QueuedChatMessage {
  id: string;
  text: string;
  attachments: ChatInputFile[];
}

export type ChatInputFileKind = "image" | "file";

export interface ChatInputFile {
  id: string;
  name: string;
  mediaType: string;
  sizeBytes: number;
  kind: ChatInputFileKind;
}

export type ChatEvent =
  | { type: "state"; session: ChatSessionInfo }
  | { type: "messageDelta"; id: string; role: string; kind: string; delta: string }
  | { type: "userInput"; id: string; text: string; attachments: ChatInputFile[] }
  | { type: "tool"; id: string; name: string; status: string; detail: string | null; output: string | null; append: boolean }
  | { type: "approval"; id: string; kind: string; title: string; detail: string | null; options: ChatApprovalDecision[]; interactive: boolean }
  | { type: "approvalResolved"; id: string; decision: ChatApprovalDecision }
  | { type: "turn"; id: string; status: string; timestamp: number }
  | { type: "queue"; items: QueuedChatMessage[] }
  | { type: "error"; message: string }
  /** 다른 화면이 이 채팅에 연결해 현재 화면의 구독이 해제되었다. 받은 쪽은 자동 재연결을 멈춘다. */
  | { type: "takenOver" }
  /** 프론트 전용: 재연결 리플레이 직전에 쌓인 스트림 항목을 비우라는 신호. 백엔드는 보내지 않는다. */
  | { type: "replayReset" };

export type ChatAttentionKind = "running" | "approval" | "completed" | "failed";

export interface ChatAttentionItem {
  id: string;
  chatId: string;
  source: ProviderId;
  providerSessionId: string | null;
  cwd: string;
  resuming: boolean;
  unattended: boolean;
  profile: ChatProfile;
  kind: ChatAttentionKind;
  title: string;
  detail: string | null;
  approvalId: string | null;
  createdAt: number;
  read: boolean;
}

export interface ChatAttentionSnapshot {
  items: ChatAttentionItem[];
  unreadCount: number;
  pendingCount: number;
}

export type ScheduleFrequency = "hourly" | "daily" | "weekdays" | "weekly" | "cron";
export type ScheduleSessionStrategy = "newChat" | "continue";
export type ResumeFailurePolicy = "pause" | "newChat" | "retryThenNewChat";
export type ScheduleRunStatus = "waitingForAccount" | "running" | "completed" | "failed" | "skipped" | "cancelled";

export interface ScheduleRecurrence {
  frequency: ScheduleFrequency;
  interval: number;
  hour: number;
  minute: number;
  weekday: number;
  cron: string | null;
  timezone: string;
}

export interface ScheduledRequestInput {
  name: string;
  prompt: string;
  source: ProviderId;
  accountId: string;
  autoSwitchWhenIdle: boolean;
  /** 전환이 세션 충돌로 막히면 관리 런타임·외부 CLI를 강제 종료하고 전환 */
  forceSessionCleanup: boolean;
  cwd: string;
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
  mode: ChatMode;
  approvalMode: ChatApprovalMode;
  recurrence: ScheduleRecurrence;
  sessionStrategy: ScheduleSessionStrategy;
  resumeFailurePolicy: ResumeFailurePolicy;
  providerSessionId: string | null;
  enabled: boolean;
}

export interface ScheduledRequest extends ScheduledRequestInput {
  id: string;
  createdAt: number;
  updatedAt: number;
  nextRunAt: number;
  lastRunAt: number | null;
  manualRunRequestedAt: number | null;
}

export interface ScheduleRun {
  id: string;
  scheduleId: string;
  scheduledFor: number;
  startedAt: number | null;
  finishedAt: number | null;
  status: ScheduleRunStatus;
  requestedAccountId: string;
  actualAccountId: string | null;
  previousActiveAccountId: string | null;
  accountSwitched: boolean;
  transitionId: string | null;
  providerSessionId: string | null;
  previousProviderSessionId: string | null;
  sessionReplaced: boolean;
  retryCount: number;
  summary: string | null;
  error: string | null;
  lastHeartbeatAt: number | null;
  cancellationRequestedAt: number | null;
  recoveryError: string | null;
}

export interface ScheduledRunCancellationReceipt {
  run: ScheduleRun;
  alreadyTerminal: boolean;
  ownerWasActive: boolean;
  stopAttempted: boolean;
  stopError: string | null;
  staleReasons: string[];
}

export interface ProviderTransitionRecoveryReceipt {
  provider: ProviderId;
  runId: string;
  transitionId: string;
  restored: boolean;
  leaseCleared: boolean;
  alreadyRecovered: boolean;
  recoveryError: string | null;
  staleReasons: string[];
}

export interface CancelAndRecoverScheduledRunReceipt {
  cancellation: ScheduledRunCancellationReceipt;
  recovery: ProviderTransitionRecoveryReceipt | null;
  partialFailure: boolean;
}

export interface SchedulerSnapshot {
  paused: boolean;
  runnerActive: boolean;
  schedules: ScheduledRequest[];
  runs: ScheduleRun[];
}

export interface BackgroundSettings {
  loginStart: boolean;
}

export type RemoteAccessPhase =
  | "disabled"
  | "starting"
  | "running"
  | "tailscaleUnavailable"
  | "conflict"
  | "error";

export interface RemoteAccessStatus {
  phase: RemoteAccessPhase;
  enabled: boolean;
  configuredPort: number;
  activePort: number | null;
  url: string | null;
  login: string | null;
  listenerActive: boolean;
  serveConfigured: boolean;
  serveTarget: string | null;
  conflictTarget: string | null;
  error: string | null;
}

export interface RemoteAccessSettingsInput {
  enabled: boolean;
  port: number;
  fullAccessAcknowledged: boolean;
  replaceExistingServe: boolean;
}

export interface ManagerSnapshot {
  schemaVersion: number;
  sessionCatalogRevision: number;
  resourceCatalogRevision: number;
  status: AppStatus;
  dashboard: DashboardStats;
  sessions: SessionSummary[];
  folders: SessionFolder[];
  skills: SkillSummary[];
  agents: AgentDefinition[];
  artifacts: ArtifactGroup[];
}

export interface TranslationMenuSettings {
  skills: boolean;
  agents: boolean;
  artifacts: boolean;
}

export interface SystemAutomationSettings {
  language: TranslationLanguage;
  additionalTranslationLanguages: TranslationLanguage[];
  systemProvider: ProviderId | null;
  translations: TranslationMenuSettings;
}

export type SystemAutomationSettingsInput = SystemAutomationSettings;

export interface UiTranslationCatalogInput {
  version: string;
  messages: Record<string, string>;
}

export interface SystemLanguageRequest {
  language: TranslationLanguage;
  catalog: UiTranslationCatalogInput;
}

export interface TranslationStatus {
  phase: "disabled" | "queued" | "running" | "complete" | "partial" | "paused" | "error" | string;
  total: number;
  completed: number;
  failed: number;
  pending: number;
  /** 캐시를 그대로 재사용해 이번 실행에서 번역하지 않은 항목 수. `completed`에 포함된다. */
  cached: number;
  segmentTotal: number;
  segmentCompleted: number;
  segmentFailed: number;
  /** `cached`의 요청 단위 값. `segmentCompleted`에 포함된다. */
  segmentCached: number;
  currentField: string | null;
  lastError: string | null;
  updatedAt: number | null;
}

export interface SystemAutomationSnapshot {
  revision: number;
  resourceCatalogRevision: number;
  settings: SystemAutomationSettings;
  pendingLanguage: TranslationLanguage | null;
  uiTranslation: TranslationStatus;
  uiMessages: Record<string, string>;
  providers: ProviderStatus[];
  skills: TranslationStatus;
  agents: TranslationStatus;
  artifacts: TranslationStatus;
}

export interface TranslationSummary {
  resourceId: string;
  fields: Record<string, string>;
  updatedAt: number;
}

export interface MenuTranslations {
  menu: TranslationMenu;
  language: TranslationLanguage;
  enabled: boolean;
  status: TranslationStatus;
  records: TranslationSummary[];
}

export interface TranslatedDetail {
  menu: TranslationMenu;
  resourceId: string;
  fields: Record<string, string>;
  updatedAt: number | null;
}

export interface SessionCatalogUpdate {
  revision: number;
  changed: boolean;
}

export interface StorageUsageItem {
  id: string;
  label: string;
  description: string;
  sizeBytes: number;
  fileCount: number;
}

export interface SupplementStorageStats {
  turnCount: number;
  sessionCount: number;
  sizeBytes: number;
}

export interface StorageOverview {
  sourceTotalBytes: number;
  managerTotalBytes: number;
  totalBytes: number;
  sourceItems: StorageUsageItem[];
  managerItems: StorageUsageItem[];
  supplements: SupplementStorageStats;
}

export interface DocRootStatus {
  id: string;
  name: string;
  path: string;
  agentData: boolean;
  exists: boolean;
}

export interface DocFile {
  rootId: string;
  relativePath: string;
  content: string;
  modifiedAt: number;
  sizeBytes: number;
}
