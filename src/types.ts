export type ProviderId = "claude" | "codex" | "antigravity";
export type HostPlatform = "macos" | "windows" | "linux";
export type ViewId = "dashboard" | "chat" | "sessions" | "docs" | "instructions" | "skills" | "agents" | "artifacts" | "workflows" | "addons" | "storage" | "settings";
export type MessageDisplayMode = "lastUser" | "start" | "latest";
export type ThemeMode = "auto" | "light" | "dark";
export type AccentColor = "brass" | "green" | "blue" | "cyan" | "violet";
export type AppLocale = string;
export type TranslationMenu = "skills" | "agents" | "artifacts" | "instructions";

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

export type CliInstallSource =
  | "notDetected"
  | "homebrewCask"
  | "homebrewFormula"
  | "npmGlobal"
  | "standalone";

export type CliUpdateMethod =
  | "unsupported"
  | "homebrewCask"
  | "homebrewFormula"
  | "npmGlobal"
  | "selfUpdate";

export type ModelCacheState = "absent" | "matched" | "mismatched" | "outdated" | "unreadable" | "unknown";

export interface ModelCacheStatus {
  id: string;
  label: string;
  path: string;
  state: ModelCacheState;
  /** 캐시를 기록한 클라이언트 버전. 최신 버전의 근거가 아니라 다른 클라이언트가 남긴 기록이다. */
  cacheClientVersion: string | null;
  cliVersion: string | null;
  error: string | null;
  cleanupAvailable: boolean;
}

export interface ProviderCliUpdateStatus {
  provider: ProviderId;
  displayName: string;
  detected: boolean;
  executablePath: string | null;
  currentVersion: string | null;
  versionError: string | null;
  installSource: CliInstallSource;
  packageName: string | null;
  updateMethod: CliUpdateMethod;
  updateSupported: boolean;
  unsupportedReason: string | null;
  updateCommandLabel: string | null;
  manualUpdateHint: string;
  checkSupported: boolean;
  checkUnsupportedReason: string | null;
  checked: boolean;
  latestVersion: string | null;
  updateAvailable: boolean;
  checkError: string | null;
  modelCaches: ModelCacheStatus[];
  /** 등록된 모델 캐시가 없을 때의 근거. 있으면 자동 캐시 정리 미지원으로 표시한다. */
  modelCacheUnsupportedReason: string | null;
  modelCacheMismatch: boolean;
}

export interface ProviderRuntimeCounts {
  provider: ProviderId;
  chatCount: number;
  terminalCount: number;
  externalProcessCount: number;
}

export interface ProviderRuntimeStopSummary {
  chatRequestedCount: number;
  chatStoppedCount: number;
  chatForcedCount: number;
  terminalRequestedCount: number;
  terminalStoppedCount: number;
  terminalForcedCount: number;
  externalRequestedCount: number;
  externalTerminatedCount: number;
  externalForcedCount: number;
  externalFailedCount: number;
}

export type CliUpdateOutcome = "updated" | "alreadyLatest" | "failed" | "verificationFailed";

export interface CliUpdateReceipt {
  provider: ProviderId;
  outcome: CliUpdateOutcome;
  method: CliUpdateMethod;
  commandLabel: string;
  previousVersion: string | null;
  targetVersion: string | null;
  currentVersion: string | null;
  verified: boolean;
  message: string;
  failureOutput: string | null;
  stopped: ProviderRuntimeStopSummary;
  status: ProviderCliUpdateStatus;
}

export interface ModelCacheCleanupEntry {
  id: string;
  label: string;
  path: string;
  removed: boolean;
  previousCacheClientVersion: string | null;
  skippedReason: string | null;
  error: string | null;
}

export interface ModelCacheCleanupReceipt {
  provider: ProviderId;
  removedCount: number;
  failedCount: number;
  entries: ModelCacheCleanupEntry[];
  stopped: ProviderRuntimeStopSummary;
  status: ProviderCliUpdateStatus;
}

export type AccountAuthStatus = "ready" | "missing" | "error";
export type AccountUsageStatus = "idle" | "ok" | "unavailable" | "error";

export interface AccountUsageWindow {
  label: string;
  usedPercent: number;
  resetsAt: number | null;
  /**
   * 특정 모델에만 걸린 창(Claude의 "Fable 7일" 등). 그 모델을 쓰지 않는 실행까지 막으면
   * 안 되므로 목록에는 보여 주되 계정 대표 소진율 계산에서는 뺀다.
   */
  modelScoped?: boolean;
}

export interface AccountUsageView {
  status: AccountUsageStatus;
  windows: AccountUsageWindow[];
  updatedAt: number | null;
  error: string | null;
  retryAt?: number | null;
  rateLimited?: boolean;
  /** 429가 사용량 조회가 아니라 OAuth 토큰 갱신에서 나왔는지. 남은 사용량과 무관하다. */
  tokenRefreshLimited?: boolean;
  /** 토큰 갱신이 연속으로 제한된 횟수. 백엔드가 재시도 간격을 넓히는 데만 쓰는 내부 값이라 화면에 쓰지 않는다. */
  tokenRefreshThrottleStreak?: number;
  /** 소진된 한도를 즉시 되돌리는 크레딧. 공급자가 주지 않으면 없다(현재 Codex만). */
  resetCredits?: AccountResetCredits | null;
}

/** 소진된 사용량 창을 즉시 되돌리는 크레딧. 장수가 한정돼 있고 만료가 있다. */
export interface AccountResetCredits {
  /** 지금 쓸 수 있는 장수. */
  availableCount: number;
  /** 가장 먼저 만료되는 크레딧의 만료 시각(ms). 만료가 없으면 null. */
  nextExpiresAt: number | null;
  /** 공급자가 준 표시 제목(예: "Full reset (Weekly + 5 hr)"). */
  title: string | null;
}

/** 리셋 크레딧 한 장을 쓴 결과. 크레딧이 실제로 줄어드는 것은 reset뿐이다. */
export type ResetCreditOutcome = "reset" | "nothingToReset" | "noCredit" | "alreadyRedeemed";

export interface ProviderAccountView {
  id: string;
  provider: ProviderId;
  displayName: string;
  email: string | null;
  organization: string | null;
  providerAccountId: string;
  /** 사용자가 직접 붙인 표시 이름. 붙이지 않았으면 null이고 displayName은 공급자 이름이다. */
  label: string | null;
  /** 공급자가 알려 준 원래 이름. 같은 사람의 계정이 여럿이면 이 값이 겹친다. */
  providerDisplayName: string;
  /**
   * 기본 계정인지. 새 채팅·터미널의 기본 실행 계정이고 헤더의 사용량 표시 대상이다.
   * 자격증명과는 무관하다 — 모든 계정은 자기 격리 프로필로 실행된다.
   */
  isActive: boolean;
  disabled: boolean;
  autoSwitch: boolean;
  /** 페일오버 우선순위(작은 값 먼저). 우선순위 정책에서만 쓰이고 미지정이면 null. */
  autoSwitchPriority: number | null;
  authStatus: AccountAuthStatus;
  usage: AccountUsageView;
  /** 계정 레지스트리에만 저장되는 사용자 메모. 메모가 없으면 null. */
  note: string | null;
  /**
   * 이 계정이 계정별 자격증명 프로필로 실행되는지. false면 공유 CLI 홈으로 실행되어
   * 다른 계정과 동시에 요청을 보낼 수 없다.
   */
  credentialIsolated: boolean;
  /** 프로필 격리를 쓰지 못한 이유. 격리가 살아 있으면 null. */
  credentialIsolationNote: string | null;
  /**
   * 이 계정에 묶인 관리 런타임 수. 0이면 이 계정으로는 아무것도 돌지 않으므로
   * 사용량이 올라갈 수 없고, 사용량 갱신을 더 뜸하게 해도 된다.
   */
  runtimeCount: number;
}

/**
 * 한도 페일오버가 다음 계정을 고르는 방식.
 * - `priority`: 사용자가 계정마다 지정한 우선순위(작은 값 먼저)
 * - `maxHeadroom`: 사용량 여유가 가장 많은 계정 먼저
 * - `registration`: 등록 순 라운드로빈
 */
export type AutoSwitchPolicy = "priority" | "maxHeadroom" | "registration";

/**
 * 세션을 이어갈 때 실행 계정을 고르는 방식. 어느 쪽이든 세션에 고정된 계정
 * (`SessionMeta.pinnedAccountId`)이 있으면 그 계정이 먼저다.
 * - `activeAccount`: 기본 계정으로 이어간다. 기본 계정을 바꾸면 이어가는 세션도 함께 옮겨진다.
 * - `lastUsedAccount`: 그 세션이 마지막으로 쓴 계정으로 이어간다.
 */
export type ResumeAccountPolicy = "activeAccount" | "lastUsedAccount";

/**
 * 자동전환 트리거.
 * - `usageExhausted`: 사용량 100% 도달
 * - `usageSpread`: 가장 덜 쓴 계정과의 사용량 격차 도달(아직 쓸 수 있어 실행 중 턴은 끊지 않는다)
 * - `agentLimited`: 에이전트 세션이 제한 응답을 받음
 */
export type AutoSwitchReason = "usageExhausted" | "usageSpread" | "agentLimited";

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
  /** 기본 계정 id. 이름은 이 계정이 공유 CLI 홈에 적용되던 시절의 것이다. */
  activeAccountId: string | null;
  /** 공유 CLI 홈의 자격증명이 등록 계정 중 하나로 확인되면 그 id(홈 관측에서 온다). */
  observedActiveAccountId: string | null;
  runtimeCount: number;
  lastAutoSwitch: AutoSwitchEventView | null;
  /** 공유 CLI 홈에 실제로 든 자격증명의 관측 결과(홈 계정). */
  home: ProviderHomeView;
}

export type HomeCredentialState = "unchecked" | "absent" | "verified" | "expired" | "error";

/**
 * 공유 CLI 홈(데스크탑 앱·터미널 CLI가 함께 쓰는 저장소)에 실제로 든 자격증명이 누구 것인지.
 * Agent Manager는 이 저장소에 쓰지 않고 여기서 읽은 토큰을 갱신하지도 않는다.
 */
export interface ProviderHomeView {
  state: HomeCredentialState;
  email: string | null;
  displayName: string | null;
  providerAccountId: string | null;
  /** 신원이 등록 계정과 같으면 그 계정 id. 미등록이거나 신원을 모르면 null. */
  accountId: string | null;
  /** 액세스 토큰 만료 시각(Claude). 지났어도 신원이 확인된 값이면 verified로 남는다. */
  accessTokenExpiresAt: number | null;
  checkedAt: number | null;
  /** 신원 조회 실패 뒤 다음 시도 시각. */
  retryAt: number | null;
  error: string | null;
  /**
   * 홈 계정의 사용량. 읽기 전용 조회로만 채운다 — 앱은 공유 홈의 토큰을 갱신하지
   * 않으므로 액세스 토큰이 살아 있는 동안에만 값이 있다. 신원이 등록 계정과 같으면
   * 그 계정이 이미 읽어 둔 값을 그대로 옮겨 온다(중복 조회를 하지 않는다).
   */
  usage: AccountUsageView;
}

export interface AccountSnapshot {
  accounts: ProviderAccountView[];
  providers: ProviderAccountStateView[];
  /** 자동전환으로 종료된 실행 중 채팅을 새 계정에서 resume으로 재시작할지 여부 */
  autoSwitchResume: boolean;
  /** 한도 페일오버가 다음 계정을 고르는 방식 */
  autoSwitchPolicy: AutoSwitchPolicy;
  /**
   * 활성 계정이 가장 덜 쓴 계정보다 이 폭(%p)만큼 앞서면 다음 계정으로 순환한다.
   * null이면 100% 도달과 에이전트 제한 응답만 페일오버를 부른다.
   */
  autoSwitchUsageGapPercent: number | null;
  /** 세션을 이어갈 때 실행 계정을 고르는 방식 */
  resumeAccountPolicy: ResumeAccountPolicy;
}

/** 계정에서 쓸 수 있는 외부 도구의 종류 */
export type AccountToolKind = "connector" | "mcpServer" | "plugin";

/**
 * 이 도구를 계정에 붙일 수 있는 근거.
 * - `account`: 이 계정에 귀속된다고 확인했다.
 * - `shared`: 계정과 무관하게 이 기기에서 항상 쓸 수 있다.
 * - `unverified`: 이 계정에서 쓸 수 있는지 확인하지 못했다. 없다는 뜻은 아니다.
 */
export type AccountToolAttribution = "account" | "shared" | "unverified";

/** 도구를 실행하지 않고 확인할 수 있는 범위의 인증·접근 상태 */
export type AccountToolAccess = "verified" | "needsAuth" | "unknown";

export interface AccountToolView {
  id: string;
  /** 아이콘 매핑에 쓰는 정규화된 서비스 슬러그 */
  service: string;
  label: string;
  kind: AccountToolKind;
  attribution: AccountToolAttribution;
  /** 공급자 홈에 설정 항목이 존재한다. 커넥터는 로컬 설정이 없어 false. */
  configured: boolean;
  exposed: boolean;
  access: AccountToolAccess;
}

export interface AccountToolsView {
  accountId: string;
  provider: ProviderId;
  /** 공급자 홈을 점유한 계정을 확인했는지. false면 계정 단위 항목은 모두 미확정. */
  attributionResolved: boolean;
  tools: AccountToolView[];
}

/** 일 단위 사용량 창의 한 주기. 백엔드 `usage_history::UsageCycleRecord`와 같다. */
export interface UsageCycleRecord {
  windowLabel: string;
  /** 공급자가 준 주기 길이(ms). */
  windowLengthMs: number;
  /** 주기의 끝(초기화 시각). */
  resetsAt: number;
  /** 이 주기에서 관측한 최대 소진율(%). */
  peakUsedPercent: number;
  firstObservedAt: number;
  lastObservedAt: number;
}
export interface AccountUsageHistory {
  accountId: string;
  /** 사용량을 처음 성공적으로 읽은 시각. 그 전 기간은 관측이 없다. */
  observedSince: number;
  cycles: UsageCycleRecord[];
}
export interface UsageHistorySnapshot {
  accounts: AccountUsageHistory[];
}
/**
 * 공유 CLI 홈에 실제로 든 로그인(홈 계정)이 쓸 수 있는 도구. 여기서 읽는 설정 자체가
 * 그 홈의 것이라, 계정 단위 항목의 귀속은 등록 계정보다 이 자리가 확실하다.
 */
export interface ProviderHomeToolsView {
  provider: ProviderId;
  /** 홈에 든 로그인의 신원을 확인했는지. false면 계정 단위 항목은 미확정으로 남는다. */
  identified: boolean;
  tools: AccountToolView[];
}

export interface AccountToolsSnapshot {
  accounts: AccountToolsView[];
  homes: ProviderHomeToolsView[];
}

/** ~/.ssh의 공개키에서 파생한 비밀 없는 표시 정보. 개인키 내용은 백엔드도 읽지 않는다. */
export interface SshKeyView {
  fileName: string;
  path: string;
  algorithm: string;
  fingerprint: string;
  comment: string | null;
  hasPrivateKey: boolean;
  /** 이 기기에 적어 둔 메모. 공개키 파일이 아니라 앱 데이터에서 온다. */
  note: string | null;
  /** 이 키로 붙는 연결 서버. 메모와 같은 기기 단위 설정이며 ~/.ssh는 손대지 않는다. */
  endpoint: SshEndpointView | null;
}

/** 인증키 하나에 묶인 연결 서버. agentEnabled가 켜져야 에이전트 목록에 나온다. */
export interface SshEndpointView {
  host: string;
  port: number;
  user: string;
  agentEnabled: boolean;
  /** 에이전트가 이 서버에서 써도 되는 명령. 비어 있으면 차단 목록만 적용된다. */
  allowedCommands: string[];
  /** 어떤 경우에도 쓰지 않을 명령. 허용 목록보다 우선한다. */
  deniedCommands: string[];
  updatedAt: number;
}

/** host가 빈 문자열이면 저장된 연결 서버를 지운다. */
export interface SetSshKeyEndpointRequest {
  fingerprint: string;
  host: string;
  port: number | null;
  user: string;
  agentEnabled: boolean;
  allowedCommands: string[];
  deniedCommands: string[];
}

/** 새 연결 서버에 채워 넣는 기본 명령 정책. 백엔드가 소유한다. */
export interface SshCommandPolicyDefaults {
  allowed: string[];
  denied: string[];
}

/** 연결 확인 결과. 원격에서는 아무것도 바꾸지 않고 고정 명령 하나만 돌린다. */
export interface SshEndpointCheckReceipt {
  fingerprint: string;
  destination: string;
  reachable: boolean;
  timedOut: boolean;
  message: string;
}

export interface SshKeyIssue {
  path: string;
  message: string;
}

export interface SshKeysSnapshot {
  directoryPath: string;
  directoryExists: boolean;
  keygenAvailable: boolean;
  keys: SshKeyView[];
  issues: SshKeyIssue[];
  commandPolicyDefaults: SshCommandPolicyDefaults;
}

export interface GenerateSshKeyRequest {
  fileName: string;
  comment: string;
}

/** 목록에서 고른 공개키 하나. 지문을 함께 보내 목록을 그린 뒤 바뀐 파일을 막는다. */
export interface SshKeyRef {
  fileName: string;
  fingerprint: string;
}

/** 공개키 본문까지 담은 조회 결과. 개인키는 여전히 열지 않는다. */
export interface SshPublicKeyView {
  fileName: string;
  path: string;
  algorithm: string;
  fingerprint: string;
  comment: string | null;
  publicKey: string;
}

/** 삭제 결과. trashPath의 파일을 ~/.ssh로 옮기면 되돌릴 수 있다. */
export interface SshKeyDeletionReceipt {
  fileName: string;
  fingerprint: string;
  trashPath: string;
  privateKeyMoved: boolean;
  noteRemoved: boolean;
  endpointRemoved: boolean;
}

export interface SetSshKeyNoteRequest {
  fingerprint: string;
  note: string;
}

/** 외부 플러그인 인증 방식. 백엔드 `external_plugins::PluginAuthKind`와 같다. */
export type ExternalPluginAuthKind = "none" | "bearer" | "oauth" | "oauthDevice" | "notionToken";

/** 도구 하나에 대한 사용자 결정. 저장되지 않은 도구는 "ask"다. */
export type PluginToolPolicy = "ask" | "allow" | "deny";

/** 일반 채팅에 실행 단위로 붙는 외부 MCP 서버. 비밀값은 절대 실리지 않는다. */
export interface ExternalPluginView {
  id: string;
  displayName: string;
  /** 원격 MCP 주소. notionToken은 백엔드가 서버를 띄우므로 null. */
  url: string | null;
  auth: ExternalPluginAuthKind;
  enabled: boolean;
  /** 사용자가 고른 OAuth scope. 없으면 프리셋 기본값이 쓰인다. */
  scope?: string | null;
  /** 도구별 허용/확인/제한. 목록에 없는 도구는 확인(ask)이다. 옛 백엔드는 내려주지 않는다. */
  toolPolicies?: Record<string, PluginToolPolicy>;
  /** 비밀값이 보안 저장소에 있는지. 인증 없는 플러그인은 항상 true. */
  credentialReady: boolean;
  /** 브라우저 승인을 기다리는 OAuth 흐름이 살아 있는지. */
  oauthPending: boolean;
  /** 새 채팅에 실제로 붙는지(사용 중이고 자격증명 준비). */
  attachable: boolean;
  serverName: string | null;
  tools: string[];
  lastVerifiedAt: number | null;
  lastError: string | null;
  authorizedAt: number | null;
  accessExpiresAt: number | null;
  createdAt: number;
  updatedAt: number;
}

/** 공급자 공식 원격 MCP 프리셋. URL·인증 방식·scope 정본은 백엔드 상수 테이블이다. */
export interface HostedMcpPreset {
  id: string;
  displayName: string;
  url: string;
  auth: ExternalPluginAuthKind;
  /** 아이콘·안내 문구를 고르는 브랜드 키(atlassian·github·figma·google). */
  brand: string;
  /** 등록 폼에 미리 채우는 기본 scope. OAuth가 아니면 빈 문자열이다. */
  defaultScope: string;
  /** 화면에서 켜고 끌 수 있는 scope. 비어 있으면 자유 입력만 받는다. */
  availableScopes: string[];
}

export interface ExternalPluginsSnapshot {
  plugins: ExternalPluginView[];
  proxyReady: boolean;
  nodeAvailable: boolean;
  maxPlugins: number;
  notionHostedUrl: string;
  notionLocalPackage: string;
  /** 공급자 프리셋. 이 목록을 내려주지 않는 옛 백엔드에 붙을 수 있어 선택 항목이다. */
  hostedPresets?: HostedMcpPreset[];
}

export interface ExternalPluginOAuthStart {
  id: string;
  authorizationUrl: string;
  expiresAt: number;
  /** 디바이스 인가에서 사용자가 승인 화면에 입력할 코드. 그 외에는 없다. */
  userCode?: string | null;
}

export interface RegisterExternalPluginRequest {
  id: string;
  displayName: string;
  url?: string | null;
  auth: ExternalPluginAuthKind;
  token?: string | null;
  clientId?: string | null;
  /** 수동 client_id에 딸린 client_secret(구글 등 DCR 미지원 서버). clientId와 함께만 유효하다. */
  clientSecret?: string | null;
  /** authorize 요청에 실을 scope. 비우면 프리셋 기본값이나 서버가 알려 준 값을 쓴다. */
  scope?: string | null;
}

/** 저장된 플러그인 편집. id는 조회 키로만 쓰이고 바뀌지 않는다. */
export interface UpdateExternalPluginRequest {
  id: string;
  displayName: string;
  url?: string | null;
  auth: ExternalPluginAuthKind;
  /** 주소·인증 방식이 바뀔 때만 필수. 비우면 호환되는 기존 토큰을 유지한다. */
  token?: string | null;
  /** 값을 주면 기존 OAuth 등록·자격증명을 초기화하고 이 client_id로 다시 인증한다. */
  clientId?: string | null;
  /** 수동 client_id에 딸린 client_secret. clientId와 함께만 유효하다. */
  clientSecret?: string | null;
  /** authorize scope. 값이 바뀌면 기존 인증을 버리고 새 동의를 받는다. */
  scope?: string | null;
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
  /** 이 세션이 마지막으로 실행된 계정. 표시용이며 이어가기 기준은 정책이 정한다. */
  boundAccountId: string | null;
  /** 사용자가 이 세션의 실행 계정으로 고정한 값. 이어가기 정책보다 우선한다. */
  pinnedAccountId: string | null;
  /** 다른 공급자에서 이 세션으로 인계한 원본. */
  handoffOrigin?: SessionLink | null;
  /** 이 세션에서 다른 공급자로 인계해 만든 세션들. */
  handoffTargets?: SessionLink[];
  /** 이 세션을 시작한 출처(워크플로 실행·반복 요청·AIA·사용자). 최초 한 번만 기록된다. */
  origin?: ChatOrigin | null;
}

export type ChatOriginKind = "workflow" | "schedule" | "aia" | "user";

/** 채팅의 출처. 서버가 실행 컨텍스트에서 채우며 클라이언트는 보낼 수 없다. */
export interface ChatOrigin {
  kind: ChatOriginKind;
  workflowId?: string | null;
  executionId?: string | null;
  scheduleId?: string | null;
  runId?: string | null;
  /** 사용량 페이싱 소비자 id. 반복 요청이 있으면 그 id, 없으면 워크플로 id. */
  consumerId?: string | null;
}

export interface SessionLink {
  source: ProviderId;
  id: string;
}

export interface SessionMetaPatch {
  favorite?: boolean;
  hidden?: boolean;
  note?: string | null;
  customTitle?: string | null;
  folderIds?: string[];
  /** 실행 계정 고정. null이면 고정을 해제해 이어가기 정책을 따른다. */
  pinnedAccountId?: string | null;
}

/**
 * 세션 정리폴더. `parentId`로 상하위 트리를 이루고 목록은 항상 트리 순서(부모 → 자식)로
 * 온다. `depth`·`sessionCount`·`totalSessionCount`는 백엔드가 조회 시점에 계산한 값이다.
 */
export interface SessionFolder {
  id: string;
  name: string;
  color: string;
  sortOrder: number;
  parentId?: string | null;
  /**
   * 숨긴 폴더. 이 폴더와 하위 폴더에만 담긴 세션은 전체 세션 목록과 상위 폴더 집계에서
   * 빠지고, 이 폴더를 직접 골랐을 때만 보인다.
   */
  hidden: boolean;
  /** 최상위는 0, 자식은 부모+1. */
  depth: number;
  /** 이 폴더에 직접 담긴 세션 수. */
  sessionCount: number;
  /**
   * 이 폴더와 숨기지 않은 하위 폴더에 담긴 세션 수(같은 세션은 한 번만 센다).
   * 숨긴 하위 폴더는 그 하위 트리째 빠진다.
   */
  totalSessionCount: number;
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
  /** AIA 전용 작업공간에서 오간 대화. 목록에서는 배지·필터로 구분한다. */
  aiaWorkspace: boolean;
  archived: boolean;
  readable: boolean;
  sizeBytes: number | null;
  filePath: string;
  meta: SessionMeta;
  /**
   * 마지막 요청이 한도 초과나 오류로 끝났으면 그 실패. 뒤에 새 요청이 오가면 null이 되고,
   * 사용자 중단은 실패로 치지 않는다.
   */
  lastFailure: SessionLastFailure | null;
}

export type SessionFailureKind = "usageLimit" | "error";

export interface SessionLastFailure {
  kind: SessionFailureKind;
  occurredAt: number | null;
  /** 실패 문구. 태그 설명용으로 백엔드가 짧게 잘라 보낸다. */
  message: string;
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

/** 세션 카탈로그에서 확인한 프로젝트 하나와 이 장치의 활성 여부(`get_project_registry`). */
export interface ProjectRegistryEntry {
  /** 정규 절대경로. 디렉터리가 사라졌으면 세션에 남은 원문. */
  path: string;
  name: string;
  /** 보관함(hidden)이 아닌 세션 수. */
  sessionCount: number;
  hiddenSessionCount: number;
  updatedAt: number | null;
  providers: ProviderId[];
  /** 설정에서 제외하지 않은 프로젝트. 제외 프로젝트의 세션은 스냅샷에서 빠진다. */
  active: boolean;
  /** 처음 감지된 뒤 아직 활성 유지/제외를 결정하지 않은 프로젝트. */
  pending: boolean;
  exists: boolean;
}

export interface SetProjectActiveRequest {
  path: string;
  active: boolean;
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
  /** 공용 보관 루트에 원본이 있는 설치본인지. 보관 구분으로 묶을 때 쓴다. */
  archived: boolean;
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

export type ClaudeSettingsScopeKind = "user" | "project" | "local" | "policy";
export type ClaudeSettingsWriteScope = "user" | "project";
export type ClaudePluginSettingValue = "true" | "false" | "custom";
export type SkillOverrideValue = "on" | "name-only" | "user-invocable-only" | "off";

export interface ClaudeScopeValues<T> {
  user?: T;
  project?: T;
  local?: T;
  policy?: T;
}

export interface ClaudeSettingsFileStatus {
  path: string;
  exists: boolean;
  parseError?: string;
}

export interface ClaudePluginState {
  pluginId: string;
  name: string;
  marketplace: string;
  version: string | null;
  installPath: string;
  skillCount: number;
  defaultEnabled: boolean;
  values: ClaudeScopeValues<ClaudePluginSettingValue>;
  effectiveEnabled: boolean;
  decidedBy: ClaudeSettingsScopeKind | null;
  locked: boolean;
}

export interface ClaudeSkillOverrideState {
  overrideKey: string;
  name: string;
  directory: string;
  scope: "personal" | "project" | string;
  projectPath: string | null;
  values: ClaudeScopeValues<SkillOverrideValue>;
  effective: SkillOverrideValue;
  decidedBy: ClaudeSettingsScopeKind | null;
  locked: boolean;
  disableModelInvocation: boolean;
}

export interface ClaudeSettingsSnapshot {
  scopes: {
    user: ClaudeSettingsFileStatus;
    project?: ClaudeSettingsFileStatus;
    local?: ClaudeSettingsFileStatus;
    policy?: ClaudeSettingsFileStatus;
  };
  plugins: ClaudePluginState[];
  skills: ClaudeSkillOverrideState[];
}

export interface SetClaudePluginEnabledRequest {
  pluginId: string;
  scope: ClaudeSettingsWriteScope;
  projectPath: string | null;
  /** null이면 이 스코프의 값을 지워 상속으로 되돌린다. */
  enabled: boolean | null;
}

export interface SetClaudeSkillOverrideRequest {
  overrideKey: string;
  scope: ClaudeSettingsWriteScope;
  projectPath: string | null;
  /** null이면 이 스코프의 값을 지워 상속으로 되돌린다. */
  value: SkillOverrideValue | null;
}

/** 공급자와 무관한 공통 스킬 원본 하나. 설정된 리소스 저장소의 `skills/<키>`가 원본 위치다. */
export interface CommonSkillSource {
  id: string;
  key: string;
  name: string;
  description: string;
  path: string;
  directory: string;
  contentDigest: string;
  fileCount: number;
  totalBytes: number;
}

export interface CommonSkillDetail {
  source: CommonSkillSource;
  body: string;
  files: FileNode[];
}

/** 공통 원본 하나의 변경 감지용 최소 요약. AIA 즉시 트리거가 짧은 주기로 읽는다. */
export interface CommonSkillDigest {
  key: string;
  name: string;
  contentDigest: string;
}

/**
 * 공통 원본이 한 공급자에서 어떻게 노출되고 있는지.
 * - `linked`: 공급자 디렉터리가 공통 원본으로 해석된다(링크·동일 경로).
 * - `copy`: 독립 사본. `divergent`가 참이면 원본과 내용이 갈라졌다.
 * - `missing`: 사용자 스킬 루트는 있으나 이 스킬이 없다.
 * - `unsupported`: 공급자가 사용자 스킬 루트를 제공하지 않는다.
 */
export type SkillProviderStatus = "linked" | "copy" | "missing" | "unsupported";

/** 한 에이전트의 위치별 설치본. 개인 루트와 각 프로젝트를 구분한다. */
export interface SkillInstallView {
  scope: string;
  projectPath: string | null;
  projectName: string | null;
  skillId: string;
  directory: string;
  contentDigest: string | null;
  divergent: boolean;
  readOnly: boolean;
}

/** 보관 시점에 기록한 출처. */
export interface SkillOriginView {
  provider: ProviderId;
  scope: string;
  projectPath: string | null;
  projectName: string | null;
  archivedAtMs: number | null;
}

export interface SkillProjectView {
  path: string;
  name: string;
}

/** 배포 위치. 생략하면 개인 루트. */
export interface SkillLocation {
  scope?: "personal" | "project";
  projectPath?: string | null;
}

export interface SkillProviderState {
  provider: ProviderId;
  status: SkillProviderStatus;
  scope: string | null;
  origin: string | null;
  skillId: string | null;
  path: string | null;
  directory: string | null;
  targetDirectory: string | null;
  readOnly: boolean;
  contentDigest: string | null;
  divergent: boolean;
  note: string | null;
  installs: SkillInstallView[];
}

export type SkillOriginKind = "common" | "provider";

export interface SkillLibraryEntry {
  key: string;
  /** 생성 시각(밀리초). 보관 원본 우선, 없으면 가장 이른 설치본. 모르면 null. */
  createdAtMs: number | null;
  /** 보관 시 기록한 출처. 없으면 개인 취급. */
  origin: SkillOriginView | null;
  /** 외부 수정 감지 시 자동 동기화 여부. */
  autoSync: boolean;
  /** base 원본을 지원하는 OS. 비어 있으면 모든 OS에서 사용할 수 있다. */
  platforms: HostPlatform[];
  /** 현재 OS에서 base 또는 OS별 변형을 활성화할 수 있는지. */
  active: boolean;
  /** 현재 OS용 원본·변형이 없어 AIA 마이그레이션이 필요한지. */
  migrationRequired: boolean;
  /** 현재 OS에서 base 위에 적용되는 변형 디렉터리. */
  activeVariant: string | null;
  name: string;
  description: string;
  originKind: SkillOriginKind;
  common: CommonSkillSource | null;
  managed: boolean;
  directoryName: string;
  providers: SkillProviderState[];
  linkedCount: number;
  installedCount: number;
  missingCount: number;
}

export interface SkillLibraryIssue {
  provider: ProviderId | null;
  path: string;
  message: string;
}

export interface SkillAdapterRootView {
  scope: string;
  path: string;
  present: boolean;
  readOnly: boolean;
  installable: boolean;
}

export interface SkillAdapterView {
  provider: ProviderId;
  displayName: string;
  installableRoot: string | null;
  roots: SkillAdapterRootView[];
  supportsCommonSource: boolean;
  note: string | null;
}

export interface SkillLibrary {
  schemaVersion: number;
  commonRoot: string;
  commonRootPresent: boolean;
  currentPlatform: HostPlatform;
  entries: SkillLibraryEntry[];
  adapters: SkillAdapterView[];
  projects: SkillProjectView[];
  issues: SkillLibraryIssue[];
}

export type SkillIssueSeverity = "blocking" | "warning";

export interface SkillCompatibilityIssue {
  severity: SkillIssueSeverity;
  provider: ProviderId | null;
  code: string;
  message: string;
}

export interface SkillProviderCompatibility {
  provider: ProviderId;
  publishable: boolean;
  requiresOverwrite: boolean;
  alreadyCurrent: boolean;
  targetDirectory: string | null;
}

export interface SkillCompatibilityReport {
  key: string;
  sourceDigest: string;
  fileCount: number;
  totalBytes: number;
  providers: SkillProviderCompatibility[];
  issues: SkillCompatibilityIssue[];
}

/** 게시 시 기존 설치본 처리 방식. 기본값은 덮어쓰기 거부다. */
export type SkillOverwritePolicy = "fail" | "replace";

export type SkillPublishOutcome = "published" | "replaced" | "unchanged" | "skipped" | "failed";

export interface SkillPublishResult {
  provider: ProviderId;
  outcome: SkillPublishOutcome;
  directory: string | null;
  message: string | null;
}

export interface SkillPublishReceipt {
  key: string;
  sourceDigest: string;
  results: SkillPublishResult[];
  report: SkillCompatibilityReport;
}

/** 휴지통 항목 실체 종류. 링크 삭제는 링크 자체만 옮기고 대상은 남긴다. */
export type SkillTrashItemKind = "directory" | "link";

export interface SkillTrashItem {
  id: string;
  /** 함께 삭제된 항목을 묶는 그룹 ID. 복구도 이 단위로 이루어진다. */
  groupId: string;
  key: string;
  kind: SkillTrashItemKind;
  originalPath: string;
  linkTarget: string | null;
  /** 에이전트 설치본이면 해당 에이전트, 공유 원본이면 null. */
  provider: ProviderId | null;
  scope: string | null;
  shared: boolean;
  deletedBy: string;
  deletedAtMs: number;
  contentDigest: string | null;
  fileCount: number;
  totalBytes: number;
  name: string;
  description: string;
}

export interface SkillTrashOverview {
  root: string;
  items: SkillTrashItem[];
  totalBytes: number;
}

export type SkillTrashRestoreOutcome = "restored" | "skipped" | "failed";

export interface SkillTrashRestoreResult {
  id: string;
  key: string;
  originalPath: string;
  outcome: SkillTrashRestoreOutcome;
  message: string | null;
}

export interface SkillTrashRestoreReceipt {
  groupId: string;
  results: SkillTrashRestoreResult[];
}

export interface SkillDeleteImpactItem {
  path: string;
  kind: SkillTrashItemKind;
  provider: ProviderId | null;
  scope: string | null;
}

export interface SkillDeleteImpact {
  key: string;
  /** 공유 저장소에 같은 키가 있는지. 설치본만 지우면 원본과 다른 배포본은 남는다. */
  shared: boolean;
  items: SkillDeleteImpactItem[];
  warnings: string[];
}

export interface SkillDeleteReceipt {
  key: string;
  groupId: string;
  items: SkillTrashItem[];
  warnings: string[];
}

export interface SkillSyncReceipt {
  key: string;
  adoptedFrom: string;
  previousSourceTrashId: string | null;
  results: SkillPublishResult[];
}

export type SkillFileChangeStatus = "added" | "removed" | "modified";

/** 보관 원본(공급자 투영 적용)과 설치본 사이의 파일 하나 차이. */
export interface SkillFileChange {
  path: string;
  status: SkillFileChangeStatus;
  executableChanged: boolean;
  /** 어느 한쪽이 UTF-8 텍스트가 아니어서 본문이 없다. */
  binary: boolean;
  /** 어느 한쪽이 비교 상한을 넘어 본문이 없다. */
  tooLarge: boolean;
  source: string | null;
  install: string | null;
}

export interface SkillInstallComparison {
  key: string;
  skillId: string;
  provider: ProviderId;
  directory: string;
  sourceDirectory: string;
  /** 바뀐 파일만. 같은 파일은 unchangedCount로만 센다. */
  files: SkillFileChange[];
  unchangedCount: number;
  symlinks: string[];
  truncated: boolean;
}

export interface SkillFileWrite {
  path: string;
  content: string;
}

export interface SkillUpdateReceipt {
  key: string;
  contentDigest: string;
  results: SkillPublishResult[];
}

export interface SkillMigrationPlan {
  key: string;
  sourcePlatforms: HostPlatform[];
  targetPlatform: HostPlatform;
  sourceDigest: string;
  files: string[];
  variantDirectory: string;
  automaticExecution: boolean;
  aiaPrompt: string;
}

export interface SaveSkillPlatformVariantRequest {
  key: string;
  targetPlatform: HostPlatform;
  sourcePlatform?: HostPlatform | null;
  files: SkillFileWrite[];
  /** 대상 OS에서 base 원본으로부터 제외할 파일 또는 디렉터리 경로. */
  deletes?: string[];
  expectedDigest: string;
}

export interface SetSkillPlatformsRequest {
  key: string;
  /** 빈 배열이면 모든 OS에서 사용하는 portable base다. */
  platforms: HostPlatform[];
  expectedDigest: string;
}

export interface ResourceRepositorySettings {
  rootPath: string;
  defaultRootPath: string;
  custom: boolean;
  skillsPath: string;
  instructionsPath: string;
  currentPlatform: HostPlatform;
}

export interface SetResourceRepositoryRequest {
  /** null 또는 빈 문자열이면 앱 데이터 내부 기본 저장소로 되돌린다. */
  rootPath?: string | null;
  migrateExisting?: boolean;
}

export interface ResourcePlatformManifest {
  schemaVersion: number;
  platforms: HostPlatform[];
  variants: Partial<Record<HostPlatform, string>>;
  variantDeletes: Partial<Record<HostPlatform, string[]>>;
}

export type InstructionPublishOutcome = "published" | "replaced" | "unchanged" | "skipped" | "failed";

/** 지침과 함께 보관하지 못한 링크. 이유를 그대로 보여 사람이 판단하게 한다. */
export interface InstructionLinkIssue {
  /** 링크를 만난 문서의 배포 루트 기준 상대 경로. 지침 파일 자신이면 빈 문자열이다. */
  source: string;
  href: string;
  reason: string;
}

export interface InstructionLinkedFileResult {
  relative: string;
  outcome: InstructionPublishOutcome;
}

export interface ProjectInstructionDeployment {
  provider: ProviderId;
  /** "personal"(공급자 홈 설정) | "project"(등록 프로젝트 루트) */
  scope: string;
  /** 파일이 놓이는 디렉터리. personal이면 공급자 설정 디렉터리다. */
  projectPath: string;
  filePath: string;
  present: boolean;
  /**
   * 이 위치가 이 원본의 배포로 원장에 올라 있는지. 지침 파일 이름은 공급자당 하나로
   * 고정이라, 파일이 있다는 사실(`present`)만으로는 우리가 배포한 것인지 알 수 없다.
   * 비교·재배포·회수는 모두 이 값이 참인 위치만 대상으로 한다.
   */
  managed: boolean;
  contentDigest: string | null;
  sourceDigest: string | null;
  /** 지침 파일과 연결 문서를 한 세트로 본 결과. 연결 문서만 달라도 참이다. 원장에 없는 위치는 항상 거짓이다. */
  divergent: boolean;
  /** 원본이 함께 보관한 연결 문서(배포 루트 기준 상대 경로). */
  linkedFiles?: string[];
  /** 배포 위치에 없는 연결 문서. */
  linkedMissing?: string[];
  /** 배포 위치에서 내용이 달라진 연결 문서. */
  linkedChanged?: string[];
  /** 배포된 지침이 참조하는데 원본에는 없는 연결 문서. 동기화하면 세트가 채워진다. */
  linkedUnarchived?: string[];
  /** 함께 보관하지 못한 링크. 정보이므로 세트 판정에는 넣지 않는다. */
  linkIssues?: InstructionLinkIssue[];
  /** 게시에서 연결 문서별 결과. */
  linkedResults?: InstructionLinkedFileResult[];
  /** 배포 위치의 세트(지침 파일 + 연결 문서) 지문. 같은 수정을 가진 위치끼리만 같다. */
  setDigest?: string;
  outcome?: InstructionPublishOutcome;
  message?: string;
}

export interface ProjectInstructionEntry {
  key: string;
  name: string;
  description: string;
  directory: string;
  sourceDigest: string;
  providers: ProviderId[];
  platforms: HostPlatform[];
  currentPlatformSupported: boolean;
  currentPlatformVariant: string | null;
  /** 외부 수정 감지 시 그 버전을 자동으로 원본에 반영하고 재배포할지. 장치별 설정. */
  autoSync: boolean;
  /** 지침과 함께 보관한 연결 문서(원본 루트 기준 상대 경로). */
  linkedFiles: string[];
  deployments: ProjectInstructionDeployment[];
}

export interface ProjectInstructionIssue {
  provider: ProviderId | null;
  path: string;
  message: string;
}

export interface ProjectInstructionLibrary {
  schemaVersion: number;
  commonRoot: string;
  commonRootPresent: boolean;
  currentPlatform: HostPlatform;
  projects: string[];
  entries: ProjectInstructionEntry[];
  deployments: ProjectInstructionDeployment[];
  issues: ProjectInstructionIssue[];
}

export interface InstructionProviderFileWrite {
  provider: ProviderId;
  content: string;
}

export interface CreateProjectInstructionRequest {
  key: string;
  name: string;
  description: string;
  files: InstructionProviderFileWrite[];
  platforms?: HostPlatform[];
}

export interface ImportProjectInstructionRequest {
  key: string;
  scope?: "personal" | "project" | null;
  projectPath?: string | null;
  provider: ProviderId;
  name?: string | null;
  description?: string | null;
  /** 함께 보관할 연결 문서(배포 루트 기준 상대 경로). 비우면 링크로 찾은 문서를 전부 보관한다. */
  linkedFiles?: string[] | null;
}

/** 가져오기 전에 그 지침이 링크로 끌고 오는 문서를 미리 보는 읽기 요청. */
export interface InstructionImportPreviewRequest {
  scope?: "personal" | "project" | null;
  projectPath?: string | null;
  provider: ProviderId;
}

/** 미리보기가 찾은 연결 문서 하나. source로 트리를 만든다. */
export interface InstructionImportLinkedDoc {
  /** 배포 루트 기준 상대 경로. 그대로 가져오기 선택 값이 된다. */
  relative: string;
  /** 이 문서를 링크한 문서의 상대 경로. 지침 파일 자신이면 빈 문자열이다. */
  source: string;
  sizeBytes: number;
}

export interface InstructionImportPreview {
  scope: string;
  projectPath: string;
  provider: ProviderId;
  filePath: string;
  sizeBytes: number;
  linkedDocs: InstructionImportLinkedDoc[];
  /** 함께 보관할 수 없는 링크. 이유를 그대로 보여준다. */
  linkIssues: InstructionLinkIssue[];
  /** 지침 파일과 연결 문서를 전부 담았을 때의 바이트 합. */
  totalBytes: number;
  /** 원본 한 세트가 담을 수 있는 바이트 한도. */
  maxTotalBytes: number;
}

export interface PublishProjectInstructionRequest {
  key: string;
  scope?: "personal" | "project" | null;
  projectPath?: string | null;
  providers: ProviderId[];
  overwrite?: SkillOverwritePolicy;
}

export interface InstructionPublishReceipt {
  key: string;
  sourceDigest: string;
  projectPath: string;
  results: ProjectInstructionDeployment[];
}

export interface ProjectInstructionMigrationPlan {
  key: string;
  sourcePlatforms: HostPlatform[];
  targetPlatform: HostPlatform;
  sourceDigest: string;
  providers: ProviderId[];
  variantDirectory: string;
  automaticExecution: boolean;
  aiaPrompt: string;
}

export interface ProjectInstructionFileContent {
  key: string;
  provider: ProviderId;
  sourceVariant: HostPlatform | null;
  content: string;
}

export interface SaveProjectInstructionPlatformVariantRequest {
  key: string;
  targetPlatform: HostPlatform;
  sourcePlatform?: HostPlatform | null;
  files: InstructionProviderFileWrite[];
  expectedDigest: string;
}

export interface SetProjectInstructionPlatformsRequest {
  key: string;
  /** 빈 배열이면 모든 OS에서 사용하는 portable base다. */
  platforms: HostPlatform[];
  expectedDigest: string;
}

export type InstructionTrashItemKind = "directory" | "file";

export interface InstructionTrashItem {
  id: string;
  groupId: string;
  key: string;
  kind: InstructionTrashItemKind;
  originalPath: string;
  provider: ProviderId | null;
  scope: string | null;
  projectPath: string | null;
  shared: boolean;
  deletedBy: string;
  deletedAtMs: number;
  contentDigest: string | null;
  fileCount: number;
  totalBytes: number;
  name: string;
  description: string;
}

export interface InstructionTrashOverview {
  root: string;
  items: InstructionTrashItem[];
  totalBytes: number;
}

export interface InstructionTrashRestoreReceipt {
  groupId: string;
  results: {
    id: string;
    key: string;
    originalPath: string;
    outcome: "restored" | "skipped" | "failed";
    message: string | null;
  }[];
}

export interface InstructionDeleteCheckRequest {
  key?: string | null;
  scope?: "personal" | "project" | null;
  projectPath?: string | null;
  provider?: ProviderId | null;
}

export interface InstructionDeleteImpact {
  key: string;
  shared: boolean;
  items: {
    path: string;
    kind: InstructionTrashItemKind;
    provider: ProviderId | null;
    projectPath: string | null;
  }[];
  warnings: string[];
}

export interface InstructionDeleteReceipt {
  key: string;
  groupId: string;
  items: InstructionTrashItem[];
  warnings: string[];
}

export interface SyncProjectInstructionRequest {
  key: string;
  scope?: "personal" | "project" | null;
  projectPath?: string | null;
  provider: ProviderId;
  deletedBy?: string | null;
}

/** 배포 원장 손질. 파일은 건드리지 않고 등록·해제만 한다. */
export interface InstructionDeploymentLinkRequest {
  key: string;
  scope?: "personal" | "project" | null;
  projectPath?: string | null;
  provider: ProviderId;
}

export interface InstructionSyncReceipt {
  key: string;
  provider: ProviderId;
  adoptedFrom: string;
  previousSourceTrashId: string | null;
  sourceDigest: string;
  results: ProjectInstructionDeployment[];
}

export interface UpdateProjectInstructionRequest {
  key: string;
  name?: string | null;
  description?: string | null;
  files: InstructionProviderFileWrite[];
  deletes?: ProviderId[];
  expectedDigest: string;
}

export interface InstructionUpdateReceipt {
  key: string;
  sourceDigest: string;
  results: ProjectInstructionDeployment[];
}

export interface DeployedInstructionFileContent {
  scope: string;
  projectPath: string;
  provider: ProviderId;
  filePath: string;
  content: string;
}

export interface SkillFileContent {
  key: string;
  path: string;
  content: string;
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
  | { kind: "runtime_failure"; status: "failed" | "interrupted" | string; code: string; text: string }
  | { kind: "image"; mediaType: string; byteSize: number; sourceOffset: number; sourcePointer: string }
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

/** 사용자가 응답을 끊은 지점. 사용자 요청도 에이전트 응답도 아니어서 구분선으로 표시한다. */
export const INTERRUPTED_ROLE = "interrupted";

/** 응답이 끝나지 못한 지점. 공급자 원문의 오류 응답과 Agent Manager가 기록한 실행 실패가 같은 모양으로 온다. */
export const RUNTIME_FAILURE_ROLE = "runtime_failure";

export interface TranscriptItem {
  index: number;
  turnId?: string | null;
  role: "user" | "assistant" | "system" | "meta" | typeof INTERRUPTED_ROLE | typeof RUNTIME_FAILURE_ROLE | string;
  timestamp: number | null;
  model: string | null;
  typeLabel: string | null;
  blocks: ContentBlock[];
  usage: TokenUsage | null;
}

export interface SessionDetail {
  session: SessionSummary;
  /** Agent Manager가 기록한 실행 실패도 일어난 시각 위치에 runtime_failure 항목으로 함께 들어온다. */
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

export type ChatMode = "plan" | "workspace" | "fullAccess" | "auto" | "dontAsk" | "manual";
export type ChatApprovalMode = "manual" | "autoReview" | "granular" | "onFailure" | "never";
export type ChatProfile = "standard" | "aia";
export type ChatPhase = "ready" | "running" | "waitingApproval" | "stopped" | "failed";
export type ChatApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel";
/** 내장 추론 수준 이름. 표시 문구를 붙일 때만 쓴다. */
export type KnownReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
/**
 * 추론 수준. CLI가 새 수준을 추가하면 백엔드 조사·AIA 제안이 그 이름을 그대로 내려주므로,
 * 내장 이름에는 자동완성만 남기고 임의 문자열도 받는다. 앱을 새로 배포하지 않고 새 수준을
 * 쓰기 위한 것이며, 표시 문구는 `reasoningLabel`이 카탈로그 설명이나 원문으로 채운다.
 */
export type ReasoningEffort = KnownReasoningEffort | (string & {});

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
  /** AIA가 제안한 모델·추론 카탈로그의 갱신 시각. 제안이 없으면 null. */
  catalogUpdatedAt: number | null;
  /** 마지막으로 조사된 CLI 버전. 재조사 요청을 버전당 한 번만 보내는 기준. */
  cliVersion: string | null;
  /** CLI가 모델 목록을 내보내지 않는데 제안이 없거나 CLI 버전보다 오래됐는지. */
  catalogStale: boolean;
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
  /** 다른 공급자 세션에서 새 세션으로 인계할 때의 원본. */
  handoffOrigin?: SessionLink | null;
  unattended?: boolean;
  /**
   * 이 실행 계정을 세션에 고정할지. 고정은 이어가기 정책과 페일오버보다 우선하므로,
   * 계정을 나눠 쓰는 무인 레인이 다음 이어가기에서 활성 계정으로 몰리지 않는다.
   */
  pinAccount?: boolean;
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
  /** 리플레이 버퍼가 오래된 이벤트를 밀어냈는지. true면 attach로 받는 스트림에 앞부분이 없다. */
  replayTruncated: boolean;
  unattended: boolean;
  /** 이 채팅의 출처. 출처를 모르는 옛 경로면 없다. */
  origin?: ChatOrigin | null;
  attached: boolean;
  interactiveApprovals: boolean;
  profile: ChatProfile;
  /** AIA 런타임이 aia_system MCP를 붙였는지. false면 시스템 도구 없이 대화만 가능하다. */
  systemTools: boolean;
  settings?: Record<string, string>;
  /**
   * 이 AIA 대화가 시작할 때 적용한 시스템 에이전트 실행설정. AIA 프로필에서만 오고,
   * 실행설정을 실을 줄 모르는 이전 버전 백엔드에서는 없다. 저장본과 달라졌으면 화면이
   * 대화를 정지하고 새 설정으로 다시 시작한다.
   */
  aiaRuntime?: AiaRuntimeSettings | null;
  /** 마지막 턴 요청 기준 컨텍스트 사용량 추정(토큰). 공급자 압축 직후에는 null. */
  contextUsedTokens: number | null;
  /** 공급자가 알려준 모델 컨텍스트 창 크기(토큰). */
  contextWindowTokens: number | null;
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

/** 에이전트가 사용자에게 되묻는 질문 하나. `kind`가 `question`인 승인에만 실려 온다. */
export interface ChatApprovalQuestion {
  question: string;
  /** 질문 옆에 붙이는 아주 짧은 꼬리표. */
  header: string;
  /** 여러 개를 고를 수 있는 질문인가. */
  multiSelect: boolean;
  options: ChatApprovalOption[];
}

export interface ChatApprovalOption {
  label: string;
  description: string;
}

/**
 * 등록 대상이 아닌 화면 요소를 가리키는 단서. `ref`는 요소 스캔 때 화면이 붙인 `data-ui-ref`,
 * 없거나 요소가 다시 그려졌으면 보이는 텍스트(+역할)로 다시 찾는다.
 */
export interface UiElementLocator {
  ref?: string | null;
  text?: string | null;
  role?: string | null;
}

export type ChatEvent =
  | { type: "state"; session: ChatSessionInfo }
  | { type: "messageDelta"; id: string; role: string; kind: string; delta: string }
  | { type: "userInput"; id: string; text: string; attachments: ChatInputFile[] }
  | { type: "tool"; id: string; name: string; status: string; detail: string | null; output: string | null; append: boolean }
  | { type: "approval"; id: string; kind: string; title: string; detail: string | null; options: ChatApprovalDecision[]; interactive: boolean; questions?: ChatApprovalQuestion[] }
  /** `answers`는 질문 카드에 실제로 실어 보낸 답(질문 원문 -> 답). 답이 없으면 오지 않는다. */
  | { type: "approvalResolved"; id: string; decision: ChatApprovalDecision; answers?: Record<string, string> }
  /**
   * AIA가 show_ui_guide로 요청한 화면 안내. 이 대화를 보고 있는 화면이 대상 화면·탭을 열고
   * 요소를 화살표로 가리킨다. 표시용 일회성 이벤트라 백엔드가 리플레이하지 않는다.
   */
  | { type: "uiGuide"; id: string; target: string | null; element: UiElementLocator | null; note: string | null }
  /**
   * AIA가 find_ui_elements로 "지금 화면에 보이는 요소 중 query에 맞는 것"을 묻는다. 화면은
   * view·tab이 있으면 먼저 열고 스캔한 뒤 answer_ui_query로 답한다.
   */
  | { type: "uiQuery"; id: string; query: string; view: string | null; tab: string | null }
  /**
   * AIA가 open_ui_element·click_ui_element로 요소를 눌러 달라고 한다. 화면은 아이아 커서를
   * 움직여 클릭하고 answer_ui_query로 `{clicked, reason?}`를 답한다. `mode`가 open이면 화면을
   * 여는 버튼(탭·메뉴·드로워/패널)만 누른다.
   */
  | { type: "uiClick"; id: string; element: UiElementLocator; mode: "open" | "click"; note: string | null }
  | { type: "turn"; id: string; status: string; timestamp: number }
  | { type: "queue"; items: QueuedChatMessage[] }
  | { type: "error"; message: string }
  /**
   * start·attach 요청이 거절되어 이 연결로는 대화를 이어갈 수 없다. 재연결을 포기할지는
   * 메시지 문구가 아니라 `code`로만 판단한다.
   */
  | { type: "rejected"; code: ChatRejectionCode; message: string; existingChatId?: string | null }
  /** 다른 화면이 이 채팅에 연결해 현재 화면의 구독이 해제되었다. 받은 쪽은 자동 재연결을 멈춘다. */
  | { type: "takenOver" }
  /** 프론트 전용: 재연결 리플레이 직전에 쌓인 스트림 항목을 비우라는 신호. 백엔드는 보내지 않는다. */
  | { type: "replayReset" };

/**
 * 채팅 handshake 거절 사유.
 * - `chatMissing`: 백엔드에 그 실행이 없다(프로세스 교체·종료). 다시 붙어도 결과가 같다.
 * - `invalid`: 요청 자체가 거절됐다. 같은 요청을 반복해도 같다.
 * - `unavailable`: 일시적 장애다. 잠시 뒤 다시 시도할 수 있다.
 */
export type ChatRejectionCode = "chatMissing" | "invalid" | "unavailable" | "sessionBusy";

/** accountSwitch는 채팅에 묶이지 않은 유일한 종류다. chatId·cwd가 비어 있고 설정의 계정 탭으로 연다. */
export type ChatAttentionKind = "running" | "approval" | "completed" | "failed" | "accountSwitch";

/** 알림을 말풍선으로 띄울 때 쓰는 대화 미리보기. 앞부분만 담기며 뒤는 잘려 있다. */
export interface ChatAttentionPreview {
  request: string | null;
  response: string | null;
}

export interface ChatAttentionItem {
  id: string;
  chatId: string;
  source: ProviderId;
  providerSessionId: string | null;
  cwd: string;
  resuming: boolean;
  unattended: boolean;
  profile: ChatProfile;
  /** 이 알림을 만든 채팅의 출처. 같은 반복 요청·워크플로 회차를 한 묶음으로 접는 기준이다. */
  origin?: ChatOrigin | null;
  kind: ChatAttentionKind;
  title: string;
  detail: string | null;
  approvalId: string | null;
  /** AIA 대화에서만 채워진다. 다른 프로필은 항상 null. */
  preview: ChatAttentionPreview | null;
  createdAt: number;
  read: boolean;
}

export interface ChatAttentionSnapshot {
  items: ChatAttentionItem[];
  unreadCount: number;
  pendingCount: number;
}

/** auto는 시스템이 정한 간격(예산 정책의 가드 창 길이, 없으면 5시간)으로 돈다. */
export type ScheduleFrequency = "hourly" | "daily" | "weekdays" | "weekly" | "cron" | "auto";
export type ScheduleSessionStrategy = "newChat" | "continue";
export type ResumeFailurePolicy = "pause" | "newChat" | "retryThenNewChat";
export type ScheduleRunStatus = "waitingForAccount" | "waitingForUsage" | "running" | "completed" | "failed" | "skipped" | "cancelled";

/** 세션 목록·통계가 쓰는 세션 상태. Rust `SessionManagementStatus`와 같은 값이다. */
export type SessionManagementStatus =
  | "ready"
  | "running"
  | "waitingApproval"
  | "completed"
  | "failed"
  | "interrupted"
  | "stopped"
  | "archived"
  | "unavailable";

/** 세션 참조 설정을 마지막으로 확정한 주체. 서버가 호출 경로로 판정하며 클라이언트가 정할 수 없다. */
export type SessionReadOrigin = "aia" | "manual";

export type SessionReadProjectScope = "scheduleCwd" | "selected" | "allRegistered";

/** 요약 / 작업 근거 / 제한된 대화 원문. */
export type SessionReadDetail = "summary" | "workRationale" | "limitedTranscript";

/** 인증정보 제거는 해제할 수 없는 최소선이고, strict는 이메일·홈 경로까지 가린다. */
export type SessionReadRedaction = "credentials" | "strict";

export type SessionReadRelativeUnit = "day" | "week" | "month";

export type SessionReadPeriod =
  | { kind: "reportPeriod" }
  | { kind: "relative"; unit: SessionReadRelativeUnit; count: number }
  | { kind: "recentDays"; days: number }
  | { kind: "absoluteRange"; from: number; to: number };

export interface SessionReadPolicy {
  enabled: boolean;
  projectScope: SessionReadProjectScope;
  /** projectScope가 selected일 때만 쓰는 등록 프로젝트 절대 경로. */
  projects: string[];
  /** 비우면 전체 공급자. 표시 순서를 그대로 쓴다. */
  providers: ProviderId[];
  period: SessionReadPeriod;
  /** 비우면 전체 상태. */
  statuses: SessionManagementStatus[];
  detail: SessionReadDetail;
  maxSessions: number;
  maxTurnsPerSession: number;
  pageSize: number;
  includeLinkedFiles: boolean;
  redaction: SessionReadRedaction;
}

export interface SessionReadSettings {
  policy: SessionReadPolicy;
  origin: SessionReadOrigin;
  /** AIA가 마지막으로 제안한 정책. `AIA 추천값 다시 적용`이 되돌릴 원본. */
  aiaRecommendation?: SessionReadPolicy | null;
}

/** 실행 이력에 남는 세션 참조 결과. */
export interface ScheduleRunSessionRead {
  granted: boolean;
  summary: string;
  windowFrom?: number | null;
  windowTo?: number | null;
  notes?: string[];
}

export interface ScheduleRecurrence {
  frequency: ScheduleFrequency;
  interval: number;
  hour: number;
  minute: number;
  weekday: number;
  cron: string | null;
  timezone: string;
}

/**
 * 반복 요청이 채팅 대신 등록된 시스템 워크플로를 돌릴 때의 대상. 문서 트리거와 같은
 * 규칙으로 승인 버전을 고정하며, 워크플로가 바뀌면 다시 승인할 때까지 실행하지 않는다.
 */
export interface ScheduleWorkflowBinding {
  workflowId: string;
  approvedVersion: number;
  arguments: Record<string, unknown>;
  /**
   * 페이싱 회차 설정. 페이싱 회차 계약(paced)을 도는 반복 요청만 쓴다. 계약 입력이 아니라
   * 반복 요청이 소유하며, 없으면 병렬 실행 없이 한 건씩 돈다.
   */
  pacing?: SchedulePacing | null;
}

export interface SchedulePacing {
  /** 한 회차에 동시에 띄울 최대 건수(병렬 실행). 1이면 한 건씩. */
  maxRuns: number;
}

export interface ScheduledRequestInput {
  name: string;
  prompt: string;
  source: ProviderId;
  accountId: string;
  // 실행 시점의 활성 계정으로 돌린다. 켜면 accountId는 비어 있다.
  useActiveAccount: boolean;
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
  /** 이 실행이 다른 에이전트 세션을 얼마나 읽을 수 있는지. 없으면 세션 참조를 쓰지 않는다. */
  sessionReference?: SessionReadSettings | null;
  /** AIA가 사용자 지정 정책을 덮어쓸 때만 쓰는 요청 전용 승인. 저장되지 않는다. */
  sessionReferenceReplaceManual?: boolean;
  /**
   * 채팅 대신 등록된 시스템 워크플로를 돌리는 반복 요청. 없으면 프롬프트를 공급자
   * 채팅으로 보낸다. 워크플로 실행에서는 프롬프트·계정·작업 경로·모델·세션 참조가
   * 저장 시점에 비워진다.
   */
  workflow?: ScheduleWorkflowBinding | null;
  /**
   * 예약 실행이 시작되는 절대 시각(epoch ms). 없으면 시작 제한이 없다. 이 시각 전의
   * 발화는 건너뛰므로 창이 열릴 때 밀린 회차가 몰아서 나가지 않는다.
   */
  activeFrom?: number | null;
  /**
   * 예약 실행이 끝나는 절대 시각(epoch ms). 없으면 종료 제한이 없다. 이 시각을 지나면
   * 예약 실행이 나가지 않지만 enabled는 그대로 남아, 종료를 미루면 다시 돈다.
   * 수동 실행은 활성 창과 무관하게 나간다.
   */
  activeUntil?: number | null;
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
  providerSessionId: string | null;
  previousProviderSessionId: string | null;
  sessionReplaced: boolean;
  retryCount: number;
  summary: string | null;
  error: string | null;
  lastHeartbeatAt: number | null;
  cancellationRequestedAt: number | null;
  recoveryError: string | null;
  // 사용자가 직접 누른 실행. 전체 일시정지 중에도 이 실행은 진행된다.
  manual: boolean;
  documentTrigger?: {
    triggerId: string;
    eventId: string;
    summary: string;
  } | null;
  /** 이 실행에 붙은 세션 참조 결과. 확정 구간과 부분 보고 사유, 사용량이 담긴다. */
  sessionReference?: ScheduleRunSessionRead | null;
  /**
   * 페이싱 회차 봉투가 이 실행에서 실제로 한 일. 회차는 기동이 0건이어도 성공이라
   * `status`만으로는 일한 회차와 쉰 회차를 가릴 수 없다.
   */
  round?: ScheduleRunRound | null;
}

/** 페이싱 회차 한 번의 집계. */
export interface ScheduleRunRound {
  /** 예산이 이번 회차에 배정한 건수. */
  plannedRuns: number;
  /** 실제로 띄운 건수. 0이면 쉰 회차다. */
  launchedRuns: number;
  /** 지난 회차에서 남아 정리한 런타임 수. */
  staleRuns: number;
  /** 이 회차의 병렬 상한. */
  maxRuns: number;
}

/** get_scheduled_run_detail 응답. 폴링 스냅샷과 달리 본문 전문을 담는다. */
export interface ScheduleRunDetail {
  run: ScheduleRun;
  summaryTruncated: boolean;
  errorTruncated: boolean;
}

export interface ScheduledRunCancellationReceipt {
  run: ScheduleRun;
  alreadyTerminal: boolean;
  ownerWasActive: boolean;
  stopAttempted: boolean;
  stopError: string | null;
  staleReasons: string[];
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
  /** 처음 감지돼 활성 유지/제외 결정을 기다리는 프로젝트. 알림으로 띄운다. */
  pendingProjects: ProjectRegistryEntry[];
}

export interface TranslationMenuSettings {
  skills: boolean;
  agents: boolean;
  artifacts: boolean;
  instructions: boolean;
}

/**
 * 시스템 에이전트(AIA)를 시작할 때 쓸 공급자별 실행설정. 항목을 비우면(`null`·빈 값)
 * 공급자 기본값을 쓰고, `settings`에는 실행설정 스키마의 동적 항목(예: Claude
 * `fallbackModel`)만 담는다. 백엔드 `SystemAgentRuntime`과 같은 구조다.
 */
export interface SystemAgentRuntime {
  model?: string | null;
  reasoningEffort?: ReasoningEffort | null;
  mode?: ChatMode | null;
  approvalMode?: ChatApprovalMode | null;
  decisionPolicy?: AiaDecisionPolicy | null;
  uiClickPolicy?: AiaUiClickPolicy | null;
  settings?: Record<string, string>;
}

/**
 * AIA 시작에 실제로 쓰이는 실행설정. 비워 둔 항목이 AIA 기본값으로 채워진 뒤의 값이며,
 * `model`·`reasoningEffort`의 `null`은 "공급자 기본값"이라는 뜻이다.
 * 백엔드 `AiaRuntimeSettings`와 같은 구조다.
 */
export interface AiaRuntimeSettings {
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
  mode: ChatMode;
  approvalMode: ChatApprovalMode;
  /** 권한 승인 밖의 선택을 사용자에게 물을지, 추천안으로 자동 진행할지. */
  decisionPolicy: AiaDecisionPolicy;
  /** 아이아 커서가 승인 없이 누를 수 있는 범위. */
  uiClickPolicy: AiaUiClickPolicy;
  settings: Record<string, string>;
}

/**
 * 아이아 커서 클릭(open_ui_element)이 승인 없이 누를 수 있는 범위. `openers`는 탭·주 메뉴·
 * 드로워/패널 여닫기처럼 화면을 여는 버튼만, `all`은 확인 모달 안을 뺀 어떤 버튼이든.
 * 백엔드 `AiaUiClickPolicy`와 같은 값이어야 한다.
 */
export type AiaUiClickPolicy = "openers" | "all";

/**
 * 권한 승인 밖의 선택(정책·작업 방향·개선안 등)을 AIA가 어떻게 처리할지.
 * `ask`는 선택지를 제시하고 사용자의 결정을 기다리고, `recommended`는 추천안을
 * 스스로 골라 진행한다. 백엔드 `AiaDecisionPolicy`와 같은 값이어야 한다.
 */
export type AiaDecisionPolicy = "ask" | "recommended";

export interface SystemAutomationSettings {
  language: TranslationLanguage;
  additionalTranslationLanguages: TranslationLanguage[];
  systemProvider: ProviderId | null;
  translations: TranslationMenuSettings;
  /** 시스템 에이전트로 고를 수 있는 공급자별 실행설정. 저장한 적이 없는 공급자는 빠져 있다. */
  systemAgentRuntimes: Partial<Record<ProviderId, SystemAgentRuntime>>;
  /** CLI 업데이트로 모델·추론 카탈로그가 오래되면 AIA에게 재조사를 자동 요청할지. */
  catalogAutoDiscovery: boolean;
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

/** 사용량 예산의 기본 목표·가드. 비어 있으면 워크플로 인자를 그대로 쓴다. */
export interface UsageBudgetDefaults {
  /**
   * 페이싱 기능 전체 스위치. 끄면 페이싱 대상 워크플로의 예약 회차가 뜨지 않는다(설정과
   * 회차는 그대로 남고, 회차 카드에서 직접 누른 실행은 종전대로 나간다).
   * 값이 없으면 켜짐이다 — 이 스위치가 생기기 전 저장본을 조용히 멈추지 않는다.
   */
  enabled?: boolean | null;
  windowLabel?: string | null;
  targetPercent?: number | null;
  guardWindowLabel?: string | null;
  guardPercent?: number | null;
  /** 페이싱 스케줄(제한 시간대). 없거나 꺼져 있으면 종일 돈다. */
  quietHours?: QuietHours | null;
  /** 소비자가 성향을 정하지 않았을 때 물려받는 기본 소비 성향. */
  spendProfile?: SpendProfile | null;
  /**
   * 소진 모드. 켜면 목표를 시간에 직선으로 펴지 않고 가드 창이 허락하는 만큼 몰아 써서 계획
   * 창을 빨리 비우고, 비워진 창을 한도 리셋 크레딧으로 되돌린다. 크레딧이 없는 계정에는
   * 걸리지 않는다 — 되돌릴 수단 없이 한도만 일찍 태우면 균등 페이싱보다 나쁘다.
   */
  drain?: boolean;
  /** 소진 모드가 자동으로 쓰지 않고 남겨 둘 리셋 크레딧 장수. 없으면 0장(전부 자동 소비). */
  drainReserveCredits?: number | null;
}

/** 계정 하나의 소진 모드 전망. 두 창의 회당 소비를 모두 실측했을 때만 시간 값이 채워진다. */
export interface UsageBudgetDrainOutlook {
  /** 예비 장수를 넘겨 자동으로 쓸 수 있는 크레딧이 남아 있는지. */
  spendable: boolean;
  availableCount: number;
  reserveCount: number;
  nextExpiresAt: number | null;
  /** 소진 모드로 계획 창을 비우는 데 걸리는 일수. 실측이 없으면 null. */
  daysToEmpty: number | null;
  /** 가장 이른 크레딧을 만료 전에 쓰려면 늦어도 소진을 시작해야 하는 시각. */
  actByAt: number | null;
  /** 그 시각을 이미 지났는지. 화면은 이 값이 참일 때 한 번만 알린다. */
  actNow: boolean;
  /** 안내를 띄운 뒤 확인 처리에 실을 크레딧 id. */
  creditId: string | null;
}

/**
 * 페이싱 스케줄: 페이싱을 멈출 시간대. 체크한 요일(`weekdays`, 0=일…6=토 —
 * `ScheduleRecurrence.weekday`와 같은 번호)의 `start`~`end`(HH:MM, `timezone`)에는 페이싱
 * 회차가 뜨지 않고, 그 밖의 시간과 체크 안 한 요일은 종일 돈다. 끝이 시작보다 이르면 다음
 * 날로 이어지는 제한이고 시작 요일에 속한다(금 22:00~토 06:00은 금요일).
 */
export interface QuietHours {
  enabled: boolean;
  start: string;
  end: string;
  timezone: string;
  weekdays: number[];
}

/**
 * 계획 창과 함께 지키는 짧은 창(가드 창) 하나의 현황. 계정이 지금 보고하는 창 중 계획 창이 아닌
 * 계정 전체 창 전부(+ 정책이 라벨로 지정한 창)라 라벨은 공급자마다·플랜마다 다를 수 있다.
 * `netHeadroomPercent`는 정책에 가드 상한이 없으면 null.
 */
export interface UsageBudgetGuardOverview {
  label: string;
  usedPercent: number;
  resetsAt: number | null;
  guardPercent: number | null;
  outstandingClaimPercent: number;
  netHeadroomPercent: number | null;
}

export interface UsageBudgetAccountOverview {
  inPool: boolean;
  usedPercent: number | null;
  resetsAt: number | null;
  targetPercent: number;
  outstandingClaimPercent: number;
  netHeadroomPercent: number;
  /** 구형 백엔드 응답에는 없다. */
  guards?: UsageBudgetGuardOverview[];
  /** 소진 모드 전망. 구형 백엔드 응답에는 없다. */
  drain?: UsageBudgetDrainOutlook;
}

export interface UsageBudgetAccount {
  accountId: string;
  email: string | null;
  provider: ProviderId;
  displayName: string;
  disabled: boolean;
  pacingEnabled: boolean;
  targetPercent: number | null;
  guardPercent: number | null;
  windows: AccountUsageWindow[];
  overview: UsageBudgetAccountOverview | null;
}

export interface UsageBudgetConsumerCost {
  percentPerRun: number;
  observationWeight: number;
}

/** 소비자의 계정별 회당 소비. `percentPerRun`은 최근 관측의 가중 평균(%p), `tokensPerRun`은 토큰 중앙값(Claude만). */
export interface UsageBudgetConsumerAccountCost {
  accountId: string;
  provider: ProviderId;
  percentPerRun: number | null;
  tokensPerRun: number | null;
  runs: number;
}

/**
 * 추론수준별 회당 소비. 등급 하나가 회당 소비를 서너 배까지 벌리므로, 등급을 축으로 갈라
 * 두어야 "얼마를 더 써서 무엇을 얻었나"를 견줄 수 있다. 등급을 남기지 않은 옛 실행은 빠진다.
 */
export interface UsageBudgetConsumerEffortCost {
  provider: ProviderId;
  reasoningEffort: string;
  percentPerRun: number | null;
  tokensPerRun: number | null;
  runs: number;
}

/** 절감 목표 기본값. 기준선은 소비자별 처음 baselineRuns회 관측의 중앙값. */
export interface SavingsDefaults {
  targetReductionPercent?: number | null;
  baselineRuns: number;
}

/** 소비자·공급자별 절감 보고. Claude는 실제 토큰, Codex는 창 %p 기준. */
export interface UsageBudgetSavingsReport {
  observations: number;
  /** 기준선을 붙박은 시각. null이면 아직 확정 전이라 값이 흔들릴 수 있다. */
  baselineFixedAt?: number | null;
  baselineCostPercent: number | null;
  currentCostPercent: number | null;
  baselineTokens: number | null;
  currentTokens: number | null;
  /** 양수면 줄었고 음수면 늘었다. 기준선이 아직 없으면 null. */
  achievedReductionPercent: number | null;
  metric: "tokens" | "costPercent" | null;
  overCeiling: string | null;
}

/**
 * 레인(공급자) 하나의 추론수준 설정. `fixed`가 있으면 고정, 없으면 자동(계정 여력)이고 `maxAuto`는
 * 자동일 때의 천장이다.
 */
export interface LaneReasoningEffort {
  fixed?: ReasoningEffort | null;
  maxAuto?: ReasoningEffort | null;
  /** 자동 판정이 내려갈 수 있는 바닥. 절감 목표가 등급을 낮출 때 여기서 멈춘다. */
  minAuto?: ReasoningEffort | null;
}

/**
 * 소비 성향 프리셋. 천장·바닥·컨트롤러를 직접 조합하지 않도록 한 값으로 묶는다.
 * - `saver` 항상 최저 등급(게이트가 품질을 지키는 일에 맞다)
 * - `goal` 천장에서 시작해 절감 목표를 채울 때까지 자동으로 내려간다
 * - `quality` 여력이 있으면 높게(게이트가 대신 지켜 주지 못하는 탐색에 맞다)
 */
export type SpendProfile = "saver" | "goal" | "quality";

export interface UsageBudgetConsumer {
  /** 소비자 = 반복 요청 id. */
  scheduleId: string;
  name: string | null;
  workflowId: string | null;
  scheduleEnabled: boolean | null;
  /** 반복 요청이 아직 존재하는지. 지워진 반복 요청의 설정만 남았으면 false(다음 조회에서 정리된다). */
  scheduleExists: boolean;
  cadenceMinutes: number | null;
  /** 정책에 등록됐으면 참여 여부, 미등록이면 null. */
  enabled: boolean | null;
  priority: number;
  label: string | null;
  /** 페이싱 계산까지 하는 워크플로인지. false면 기동(start_chat)만 예산이 통제한다. */
  paced: boolean | null;
  /** 워크플로별 참여 계정. 빈 배열이면 제한 없음(전역 풀 그대로). */
  workflowAccounts: string[];
  maxTokensPerRun: number | null;
  maxCostPercentPerRun: number | null;
  enforceCeiling: boolean;
  /**
   * 레인(공급자)별 추론수준 설정. 항목이 없는 공급자는 자동(계정 여력)·상한 없음. 구형 백엔드는
   * 필드 없음.
   */
  reasoningEfforts?: Partial<Record<ProviderId, LaneReasoningEffort>>;
  /** 이 소비자의 소비 성향. 없으면 기본값의 성향을 물려받는다. */
  spendProfile?: SpendProfile | null;
  costs: {
    perProvider: Partial<Record<ProviderId, UsageBudgetConsumerCost>>;
    /**
     * 계정(에이전트)별 회당 소비·토큰. 한 회차가 여러 계정으로 돌았을 때 카드가 따로 보여 준다.
     * 구형 백엔드는 필드가 없다.
     */
    perAccount?: UsageBudgetConsumerAccountCost[];
    /** 추론수준별 회당 소비. 구형 백엔드는 필드가 없다. */
    perEffort?: UsageBudgetConsumerEffortCost[];
    recordedRuns: number;
    savings: Partial<Record<ProviderId, UsageBudgetSavingsReport>>;
  } | null;
  /**
   * 다음 회차의 기동 예상(페이싱 계산을 하는 회차만, 구형 백엔드는 필드 없음). 지금 사용량으로
   * 봉투와 같은 계획을 기록 없이 계산한 값이라 회차가 뜰 때는 달라질 수 있다. runs가 비면
   * note가 이유다.
   */
  nextRun?: {
    runs: {
      accountId: string;
      email: string | null;
      provider: ProviderId;
      model: string | null;
      /** 봉투가 레인 설정·계정 여력으로 고른 추론수준. 구형 백엔드는 필드 없음. */
      reasoningEffort?: ReasoningEffort | null;
      /** 추론수준의 출처. 자동이면 `headroomRunsPerRound`(리셋까지 남은 회차당 감당 건수)가 근거다. */
      reasoningEffortSource?: "auto" | "fixed" | null;
      headroomRunsPerRound?: number | null;
      count: number;
    }[];
    note: string | null;
  } | null;
  /** 이 회차와 같은 계정 범위를 공유하는 활성 회차 그룹의 처리량. 구형 백엔드는 필드 없음. */
  throughput?: UsageBudgetThroughput | null;
}

/**
 * 같은 계정 범위를 공유하는 페이싱 회차들이 리셋까지 목표를 채울 수 있는지.
 *
 * 회당 소비가 워크플로마다 달라 "시간당 몇 건"은 회차끼리 견줄 수 없으므로 시간당
 * 사용률(%p/h)로 환산해 합친다. 계정 범위가 다른 회차는 서로 별도 판정이다.
 */
export interface UsageBudgetThroughput {
  /** 리셋까지 목표를 채우려면 풀 전체가 시간당 소비해야 하는 사용률(%p/h). */
  demandPercentPerHour: number;
  /** 켜져 있는 회차들이 낼 수 있는 합계(%p/h). */
  supplyPercentPerHour: number;
  reachesTarget: boolean;
  rounds: UsageBudgetRoundThroughput[];
}

/** 회차 하나가 풀에 보태는 몫. */
export interface UsageBudgetRoundThroughput {
  scheduleId: string;
  maxRuns: number;
  cadenceMinutes: number;
  /** 최근 표본의 평균 회차 소요시간(분). 표본이 없으면 null. */
  runMinutes: number | null;
  costPercentPerRun: number;
  supplyPercentPerHour: number;
  /**
   * 이 회차만으로 풀의 부족분을 메우려면 필요한 동시 실행 상한. 풀이 이미 충분하거나 계약
   * 상한까지 올려도 못 메우면 null.
   */
  recommendedMaxRuns: number | null;
}

export interface UsageBudgetSnapshot {
  defaults: UsageBudgetDefaults;
  savings: SavingsDefaults;
  /** 소비자가 하나라도 등록돼 선택이 켜졌는지. */
  selectionConfigured: boolean;
  /** 페이싱 계정 풀이 있는지(켜진 계정이 하나라도 있는지). */
  poolConfigured: boolean;
  windowLabel: string;
  cadenceMinutes: number;
  activeConsumers: string[];
  accounts: UsageBudgetAccount[];
  consumers: UsageBudgetConsumer[];
  /** 단일 계정 범위만 있을 때의 구형 화면 호환 판정. 새 화면은 consumers[].throughput 사용. */
  throughput?: UsageBudgetThroughput | null;
  /** 페이싱이 통제하는 워크플로 id. 계약이 사용량을 쓰는지가 이 목록을 정한다. */
  pacingWorkflowIds: string[];
  /**
   * 페이싱 스케줄의 현재 상태. 스케줄이 꺼져 있으면 null. `changesAt`은 제한 중이면 재개 시각,
   * 열려 있으면 다음 제한 시작(8일 안에 없으면 null).
   */
  quietStatus?: { blocked: boolean; changesAt: number | null } | null;
  /** 공급자별 추론수준 사다리(낮은 것부터). 회차 설정 선택지의 원본. 구형 백엔드는 필드 없음. */
  reasoningEffortLadders?: Partial<Record<ProviderId, ReasoningEffort[]>>;
}

export interface SetUsageBudgetAccountRequest {
  accountId: string;
  pacingEnabled: boolean;
  targetPercent?: number | null;
  guardPercent?: number | null;
}

export interface SetUsageBudgetConsumerRequest {
  scheduleId: string;
  enabled: boolean;
  priority?: number | null;
  label?: string | null;
  workflowId?: string | null;
  /** 생략하면 기존 값 유지, 0이면 상한 해제. */
  maxTokensPerRun?: number | null;
  maxCostPercentPerRun?: number | null;
  enforceCeiling?: boolean | null;
  /** 레인별 추론수준. 생략하면 유지, 주면 통째로 교체(항목 없는 공급자는 자동·상한 없음). */
  reasoningEfforts?: Partial<Record<ProviderId, LaneReasoningEffort>> | null;
  /**
   * 소비 성향 프리셋. 칸을 빼면 기존 값 유지, `null`을 실어 보내면 해제해 예산 기본값의
   * 성향을 물려받는다 — `undefined`와 `null`이 백엔드에서 다른 뜻이므로 "그대로"를 뜻할 때
   * 널을 넣지 않는다.
   */
  spendProfile?: SpendProfile | null;
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
  instructions: TranslationStatus;
  /** 상세 화면에서 직접 요청한 리소스 단위 번역. 성공하면 목록에서 사라진다. */
  resourceTranslations: ResourceTranslationJob[];
}

export interface ResourceTranslationJob {
  menu: TranslationMenu;
  resourceId: string;
  phase: "queued" | "running" | "error" | string;
  segmentTotal: number;
  segmentCompleted: number;
  lastError: string | null;
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
  restricted: boolean;
}

export interface DocFile {
  rootId: string;
  relativePath: string;
  content: string;
  modifiedAt: number;
  sizeBytes: number;
}

export type DocumentPreviewKind = "markdown" | "text" | "binary" | "tooLarge";

export interface DocumentEntry {
  name: string;
  relativePath: string;
  parentPath: string;
  sizeBytes: number;
  modifiedAt: number;
  isDirectory: boolean;
  previewKind: DocumentPreviewKind | null;
}

export interface DocumentEntryPage {
  entries: DocumentEntry[];
  nextCursor: string | null;
  total: number;
}

export interface DocumentFile {
  rootId: string;
  relativePath: string;
  kind: DocumentPreviewKind;
  content: string | null;
  modifiedAt: number;
  sizeBytes: number;
  downloadable: boolean;
}

export type DocumentChangeKind = "created" | "modified" | "deleted";
export type DocumentTriggerStatus = "active" | "paused" | "degraded" | "needsReview" | "restricted";
export type DocumentTriggerRunStatus = "running" | "completed" | "failed" | "skipped";

export type DocumentTriggerAction =
  | { type: "runSchedule"; scheduleId: string }
  | { type: "startChat"; source: ProviderId; accountId?: string | null; model?: string | null; reasoningEffort?: ReasoningEffort | null; mode: ChatMode; approvalMode: ChatApprovalMode; prompt: string; skill?: { skillId: string; contentDigest: string } | null; settings?: Record<string, string> }
  | { type: "executeWorkflow"; workflowId: string; approvedVersion: number; arguments?: Record<string, unknown> };

export interface DocumentTriggerInput {
  name: string;
  rootId: string;
  include: string[];
  exclude: string[];
  changeKinds: DocumentChangeKind[];
  enabled: boolean;
  debounceMs: number;
  cooldownMs: number;
  action: DocumentTriggerAction;
}

export interface DocumentTrigger extends DocumentTriggerInput {
  id: string;
  status: DocumentTriggerStatus;
  statusReason: string | null;
  createdAt: number;
  updatedAt: number;
}

export type WorkflowRisk = "readOnly" | "mutating" | "destructive";
export type WorkflowStepStatus = "succeeded" | "skipped" | "failed";
export type WorkflowInputKind = "string" | "number" | "boolean" | "enum";

export interface WorkflowInputField {
  type: WorkflowInputKind;
  values?: string[] | null;
  required: boolean;
  description?: string | null;
  /** 화면 표시 이름. 없으면 입력 키를 제목으로 쓴다. */
  label?: string | null;
  /** 계약이 선언한 기본값. 폼이 이 값을 미리 채우고, 생략된 입력은 실행이 이 값으로 채운다. */
  defaultValue?: string | number | boolean | null;
}

export interface SystemWorkflowStep {
  id: string;
  operation: string;
  arguments: unknown;
  forEach: { step: string; path?: string; maxIterations: number } | null;
  condition: unknown | null;
  expect: unknown | null;
}

export interface SystemWorkflowContract {
  id: string;
  displayName: string;
  description: string;
  inputSchema: Record<string, WorkflowInputField>;
  steps: SystemWorkflowStep[];
  risk: WorkflowRisk;
  version: number | null;
  /** 페이싱 회차 계약. 스케줄러가 회차 봉투를 두르고 계약은 한 건의 작업만 기술한다. */
  paced?: boolean;
}

/**
 * 페이싱이 어디서 이뤄지는지. envelope = 스케줄러의 회차 봉투(권장), contract = 계약 안의
 * 계산 단계(구형, 이관 대상), launchGate = 계산 없이 기동 게이트만, null = 대상 아님.
 */
export type WorkflowPacingMode = "envelope" | "contract" | "launchGate";

export interface SystemWorkflowExecutionSummary {
  executionId: string;
  version: number;
  startedAt: number;
  finishedAt: number;
  succeeded: boolean;
  failedStepId: string | null;
  stepStatuses: { stepId: string; status: WorkflowStepStatus; iterations: number }[];
}

export interface SystemWorkflowVersion {
  version: number;
  registeredAt: number;
  computedRisk: WorkflowRisk;
  requiredOperations: string[];
}

/** `get_system_workflows`의 목록 항목. 계약 본문은 상세 조회에서만 온다. */
export interface SystemWorkflowSummary {
  id: string;
  displayName: string | null;
  description: string | null;
  version: number | null;
  risk: WorkflowRisk | null;
  computedRisk: WorkflowRisk | null;
  requiredOperations: string[] | null;
  inputSchema: Record<string, WorkflowInputField> | null;
  /** 저장된 계약이 현재 system_catalog와 맞지 않으면 false. 실행할 수 없다. */
  compatible: boolean;
  contractDigest: string | null;
  hardToRecoverEffects: string[] | null;
  lastExecution: SystemWorkflowExecutionSummary | null;
  /** 계약이 사용량을 쓰는지(페이싱 회차 계약, 페이싱 계산 또는 무인 런타임 기동 단계 보유). 페이싱 대상 여부의 기본값. */
  pacingCapable: boolean;
  /** 사용량 예산이 이 워크플로를 통제하는지. 페이싱 회차 계약은 항상 true, 그 밖에는 저장된 옛 값이 없으면 `pacingCapable`과 같다. */
  pacingEnabled: boolean;
  /** 페이싱 방식. 구형 백엔드 응답에는 없다. */
  pacingMode?: WorkflowPacingMode | null;
  /** 최신 버전이 페이싱 회차 계약인지. */
  paced?: boolean;
}

/** 워크플로 하나의 페이싱 설정(참여 계정)을 바꾼다. 응답은 갱신된 워크플로 목록. */
export interface SetSystemWorkflowPacingRequest {
  workflowId: string;
  pacingEnabled: boolean;
  /** 이 워크플로가 쓸 계정. 생략하면 유지, 빈 배열이면 제한 해제, 목록이면 교체. */
  accounts?: string[];
}

export interface SystemWorkflowDetail extends SystemWorkflowSummary {
  contract: SystemWorkflowContract | null;
  versions: SystemWorkflowVersion[];
}

export interface SystemWorkflowLimits {
  maxWorkflows: number;
  maxSteps: number;
  maxForEachIterations: number;
  maxTotalOperationCalls: number;
  allowedControl: string[];
  forbidden: string[];
}

export interface SystemWorkflowList {
  limits: SystemWorkflowLimits;
  workflows: SystemWorkflowSummary[];
}

export interface SystemWorkflowStepReport {
  stepId: string;
  operation: string;
  status: WorkflowStepStatus;
  iterations: number;
  skippedItems: unknown[];
  changedTargets: unknown[];
  error: string | null;
}

export interface SystemWorkflowExecution {
  workflowId: string;
  version: number;
  executionId: string;
  startedAt: number;
  finishedAt: number;
  succeeded: boolean;
  failedStepId: string | null;
  failure: string | null;
  retryable: boolean;
  steps: SystemWorkflowStepReport[];
  /** 회차 봉투 실행이면 true. 단계 대신 회차 요약(round)을 함께 준다. */
  paced?: boolean;
  round?: {
    maxRuns: number;
    plannedRuns: number;
    launchedRuns: number;
    staleRuns: number;
    consumerId: string | null;
    reasoning: string[] | null;
  } | null;
}

export interface DocumentTriggerRun {
  id: string;
  triggerId: string;
  eventId: string;
  action: string;
  status: DocumentTriggerRunStatus;
  startedAt: number;
  finishedAt: number | null;
  resultId: string | null;
  error: string | null;
  test: boolean;
}

export interface DocumentOfflineChangeReport {
  id: string;
  createdAt: number;
  rootCount: number;
  totalCount: number;
  omittedCount: number;
  acknowledged: boolean;
  changes: Array<{ rootId: string; rootPath: string; totalCount: number; omittedCount: number }>;
}

export interface DocumentActionOption {
  id: string;
  label: string;
  detail: string | null;
  version?: number | null;
  contentDigest?: string | null;
  hardToRecoverEffects?: string[];
}

export interface DocumentAutomationSnapshot {
  triggers: DocumentTrigger[];
  runs: DocumentTriggerRun[];
  offlineReport: DocumentOfflineChangeReport | null;
  options: {
    scheduledRequests: DocumentActionOption[];
    skills: DocumentActionOption[];
    workflows: DocumentActionOption[];
  };
}

/** 감시자가 붙는 스캔 종류. 하나가 멈춰도 나머지 갱신은 계속된다. */
export type CatalogScanKind = "skills" | "agents" | "artifacts";

/** 제한 시간 안에 끝나지 않아 포기한 스캔 한 건. */
export interface CatalogDegradedScan {
  kind: CatalogScanKind;
  label: string;
  retryAt: number | null;
  message: string;
}

/** 카탈로그 갱신 상태. 목록이 조용히 멈추는 것을 화면이 알아채는 근거다. */
export interface CatalogHealth {
  sessionRevision: number;
  resourceRevision: number;
  lastReconciledAt: number | null;
  lastReconcileError: string | null;
  reconcileInFlight: boolean;
  lastResourceScanAt: number | null;
  degradedScans: CatalogDegradedScan[];
  stale: boolean;
  checkedAt: number;
}

// ---- Cypress 자동화 작업공간 (설정 → 자동화) ----

export type CypressRunState = "running" | "passed" | "failed" | "timedOut" | "error";

export interface CypressWorkspace {
  id: string;
  name: string;
  path: string;
  /** 사용자가 따로 지정한 Cypress 모듈 위치. null이면 작업공간 안에 설치한다. */
  moduleDir: string | null;
  /** 앱이 만든 기본 작업공간. 제거할 수 없다. */
  builtin: boolean;
  createdAt: number;
  moduleReady: boolean;
  cypressVersion: string | null;
}

export interface CypressRegistry {
  /** AIA가 Cypress 자동화를 실행할 수 있는지. */
  enabled: boolean;
  workspaces: CypressWorkspace[];
}

export interface CypressWorkspaceFile {
  path: string;
  sizeBytes: number;
  /** cypress.env.json처럼 비밀정보를 담는 파일. */
  sensitive: boolean;
}

export interface CypressWorkspaceFileContent {
  path: string;
  content: string;
  sensitive: boolean;
  /** 원격 접속에서 민감 파일 내용을 가린 채 왔는지. true면 편집·저장할 수 없다. */
  masked: boolean;
}

export interface CypressRunTest {
  title: string;
  state: string;
  error: string | null;
}

export interface CypressRunSpec {
  spec: string;
  tests: CypressRunTest[];
}

export interface CypressRunSummary {
  passed: number;
  failed: number;
  pending: number;
  durationMs: number;
  specs: CypressRunSpec[];
  screenshots: string[];
}

export interface CypressRunArtifact {
  path: string;
  sizeBytes: number;
  kind: "json" | "text" | "image" | "other";
  /** json·text 산출물은 내용을 함께 준다. 그 외는 null. */
  content: string | null;
}

export interface CypressRunStatus {
  jobId: string;
  workspaceId: string;
  spec: string | null;
  state: CypressRunState;
  startedAt: number;
  finishedAt: number | null;
  summary: CypressRunSummary | null;
  artifacts: CypressRunArtifact[];
  outputTail: string;
  message: string | null;
}

export interface CypressInstallReceipt {
  workspace: CypressWorkspace;
  output: string;
}
