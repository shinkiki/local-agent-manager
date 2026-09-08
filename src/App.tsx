import { lazy, memo, Suspense, useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type MutableRefObject, type ComponentType, type ReactNode, type SetStateAction } from "react";
import "./App.css";
import type { AiaAttentionTarget, AiaAutoPrompt } from "./components/AiaChatPopup";
import type { ChatTab, ChatViewAttentionTarget } from "./components/ChatView";
import type { SettingsTabId } from "./components/SettingsView";
import type { WorkflowsTabId } from "./components/WorkflowsView";
import type { AddonsTabId } from "./components/AddonsView";
import { UiGuidePointer } from "./components/UiGuidePointer";
import { createAiaScreenBridge } from "./lib/aiaScreenBridge";
import { isViewId, resolveUiGuideTarget, UI_GUIDE_VIEW_TABS, uiGuideAnchorSelector, type TabRequest } from "./lib/uiGuide";
import { activateUiElement, collectVisibleUiElements, locateUiElement, rankUiElements, uiClickRefusal } from "./lib/uiElements";
import { UiCursor, type UiCursorState } from "./components/UiCursor";
import { waitForVisibleElement } from "./lib/waitForVisibleElement";
import { errorText } from "./lib/errorText";
import { e2eHooksEnabled, installE2eHooks } from "./lib/e2eHooks";
import { ChatAttentionCenter } from "./components/ChatAttentionCenter";
import { NewProjectsModal } from "./components/NewProjectsModal";
import { DashboardView } from "./components/DashboardView";
import { AiaMark, ErrorBanner, HelpHint, LoadingState, LogoMark } from "./components/Shared";
import type { SessionAttentionTarget } from "./components/SessionsView";
import { readSessionTranscriptLimit, SESSION_TRANSCRIPT_LIMIT_KEY } from "./components/SessionTranscript";
import {
  clearReadChatAttention,
  analyzeAiaEvent,
  answerUiQuery,
  dismissChatAttention,
  getAiaSuggestionCatalog,
  getAntigravityUsage,
  getDetachedChatForSession,
  getCommonSkillDigests,
  getManagerSnapshot,
  getProviderAccounts,
  BackendBusyError,
  getCatalogHealth,
  getChatAttentionSnapshot,
  getSchedulerSnapshot,
  getSystemAutomationSnapshot,
  hasTauriRuntime,
  markAllChatAttentionRead,
  markChatAttentionRead,
  reconcileSessionCatalog,
  refreshProviderAccountUsages,
  refreshSessionCatalog,
  RemoteConnectionError,
  setProjectActive,
  setSchedulesPaused,
} from "./lib/ipc";
import { SESSION_SYNC_DELAYS_MS, sessionSyncKey, unindexedRunTargets } from "./lib/sessionSyncBudget";
import { adoptFoundSession, resolveAttentionRoute } from "./lib/attentionRoute";
import {
  canDispatchAiaEvent,
  captureAiaEventBaseline,
  clearAiaSkillChange,
  coalesceAiaEvents,
  detectAiaEvents,
  dismissAiaSuggestion,
  emptyAiaEventBudget,
  emptyAiaSkillChangeState,
  emptyAiaSuggestionHistory,
  evaluateAiaSuggestionState,
  observeAiaSkillChanges,
  parseAiaEventBudget,
  parseAiaSkillChangeState,
  parseAiaSuggestionHistory,
  recordAiaEventDispatch,
  serializeAiaEventBudget,
  serializeAiaSkillChangeState,
  serializeAiaSuggestionHistory,
  suggestionFingerprint,
  type AiaEvent,
  type AiaEventBaseline,
  type AiaSkillChangeState,
  type AiaSuggestion,
  type AiaSuggestionCatalog,
  type AiaSuggestionHistory,
} from "./lib/aiaSuggestions";
import { aiaAttentionBubble, selectAiaAttention, shouldShowAiaAttentionBubble, withoutAiaAttention } from "./lib/aiaAttention";
import {
  clearReadAttentionLocally,
  dismissAttentionLocally,
  markAllAttentionReadLocally,
  markAttentionReadLocally,
} from "./lib/chatAttention";
import { aiaRuntimeProvider, aiaRuntimeSettings } from "./lib/aiaRuntime";
import { navigationHelpDescription } from "./lib/navigationHelp";
import { firstVisibleView, loadNavigationPreferences, previewView, saveNavigationPreferences, type ConfigurableViewId, type NavigationPreferences } from "./lib/navigationPreferences";
import { accountUsageDisplayState, elapsedResetSignature, usageRefreshDeferred, usageRefreshInterval, usageResetElapsedSinceUpdate } from "./lib/accountUsage";
import { homeUsageRefreshDue } from "./lib/homeAccount";
import { sidebarUsageSources } from "./lib/sidebarUsage";
import type { SidebarUsageDensity } from "./lib/sidebarUsage";
import { useI18n } from "./lib/i18n";
import { collectRecentModels } from "./lib/recentModels";
import { normalizeManagerSnapshot } from "./lib/sessionCatalog";
import { recountSessionFolders } from "./lib/sessionFolders";
import { usePoll } from "./lib/poll";
import { refreshProviderOptions } from "./lib/providerOptions";
import { discoveryRequestKey, parseDiscoveryRequests, rememberDiscoveryRequests, schemaDiscoveryPrompt, staleCatalogSources } from "./lib/schemaDiscovery";
import { parsePopoutRequest, type PopoutRequest } from "./lib/popout";
import { closePopoutWindow } from "./lib/popoutWindow";
import { applyAccentColor, applyThemeMode, loadAccentColor, loadThemeMode, saveAccentColor, saveThemeMode } from "./lib/theme";
import { notifyNewAttention, notifyNewProjects } from "./lib/webNotifications";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { BookOpen, Bot, FileText, HardDrive, LayoutDashboard, Layers, MessagesSquare, PackagePlus, Puzzle, Settings, Sparkles, Workflow, type LucideIcon } from "lucide-react";
import { AppStatusbar } from "./components/AppStatusbar";
import { ErrorBoundary } from "./components/ErrorBoundary";
import type { AccountSnapshot, AccountUsageView, AccentColor, CatalogHealth, ChatAttentionItem, ChatAttentionSnapshot, ChatEvent, ManagerSnapshot, MessageDisplayMode, ProjectOption, ProjectRegistryEntry, ProviderId, ProviderStatus, SchedulerSnapshot, SessionFolder, SessionMeta, SessionSummary, SessionTranscriptLimit, SystemAutomationSnapshot, ThemeMode, TranslationStatus, ViewId } from "./types";

const MESSAGE_DISPLAY_MODE_KEY = "agent-manager.message-display-mode.v2";
const LEGACY_MESSAGE_DISPLAY_MODE_KEY = "agent-manager.message-display-mode.v1";
const AIA_SUGGESTION_HISTORY_KEY = "aia-suggestions-v1";
const AIA_EVENT_BUDGET_KEY = "aia-suggestion-events-v1";
const AIA_SKILL_CHANGE_KEY = "aia-skill-changes-v1";
const CATALOG_DISCOVERY_REQUEST_KEY = "catalog-discovery-requests-v1";
const ACTIVE_VIEW_KEY = "agent-manager.active-view.v1";
const SIDEBAR_USAGE_DENSITY_KEY = "agent-manager.statusbar-usage-density.v1";
/** 사이드바 Antigravity 사용량 폴링 주기. 백엔드가 30초 캐시를 두므로 그보다 자주 두드릴 이유가 없다. */
const ANTIGRAVITY_USAGE_POLL_MS = 60_000;

/**
 * localStorage 한 키에 담기는 화면 상태. 키·해석·직렬화를 한 자리에 묶어 두면 읽는 쪽과
 * 쓰는 쪽이 서로 다른 키나 직렬화를 집을 수 없다. 저장소가 막힌 환경(프라이빗 창·정책
 * 차단)에서는 읽기가 기본값으로, 쓰기가 무동작으로 떨어져 현재 실행 중의 선택만 남는다.
 */
function localStore<T>({ key, parse, serialize, fallback }: {
  key: string;
  parse: (raw: string | null) => T;
  serialize: (value: T) => string;
  fallback: () => T;
}) {
  return {
    load: (): T => {
      try { return parse(window.localStorage.getItem(key)); }
      catch { return fallback(); }
    },
    save,
    /** 쓰기 전에 값이 실제로 달라졌는지를 저장 형태로 비교할 때 쓴다. */
    serialize,
    /**
     * 저장 형태가 달라졌을 때만 값을 갈아 끼우고 함께 저장하는 setState 갱신자.
     * 상태 갱신과 저장이 늘 같은 판정 위에서 함께 일어나므로, 화면에는 올라갔는데
     * 저장은 건너뛴(또는 그 반대인) 어긋난 상태가 생기지 않는다. 내용이 같으면 현재
     * 참조를 그대로 돌려 숨은 뷰까지 다시 그려지는 것도 막는다.
     */
    saveIfChanged: (compute: (current: T) => T) => (current: T): T => {
      const next = compute(current);
      if (serialize(next) === serialize(current)) return current;
      save(next);
      return next;
    },
  };

  function save(value: T): void {
    try { window.localStorage.setItem(key, serialize(value)); }
    catch { /* 저장소가 막혀도 현재 실행 중의 선택은 그대로 적용된다. */ }
  }
}

const messageDisplayModeStore = localStore<MessageDisplayMode>({
  key: MESSAGE_DISPLAY_MODE_KEY,
  parse: (stored) => {
    if (stored === "lastUser" || stored === "start" || stored === "latest") return stored;
    // v1은 기본값("latest")도 자동 저장돼 명시 선택과 구분되지 않는다. 기본값이 아니었던
    // "start"(구 "fixed")만 이어받고, 나머지는 새 기본값인 lastUser로 시작한다.
    const legacy = window.localStorage.getItem(LEGACY_MESSAGE_DISPLAY_MODE_KEY);
    return legacy === "start" || legacy === "fixed" ? "start" : "lastUser";
  },
  serialize: (mode) => mode,
  fallback: () => "lastUser",
});
const aiaSuggestionHistoryStore = localStore({
  key: AIA_SUGGESTION_HISTORY_KEY,
  parse: parseAiaSuggestionHistory,
  serialize: serializeAiaSuggestionHistory,
  fallback: emptyAiaSuggestionHistory,
});
const aiaEventBudgetStore = localStore({
  key: AIA_EVENT_BUDGET_KEY,
  parse: parseAiaEventBudget,
  serialize: serializeAiaEventBudget,
  fallback: emptyAiaEventBudget,
});
const aiaSkillChangeStore = localStore({
  key: AIA_SKILL_CHANGE_KEY,
  parse: parseAiaSkillChangeState,
  serialize: serializeAiaSkillChangeState,
  fallback: emptyAiaSkillChangeState,
});
const sessionTranscriptLimitStore = localStore<SessionTranscriptLimit>({
  key: SESSION_TRANSCRIPT_LIMIT_KEY,
  parse: () => readSessionTranscriptLimit(),
  serialize: (limit) => limit,
  fallback: readSessionTranscriptLimit,
});
/** 하단 상태바의 사용량 표시 밀도. 기본은 접힌 한 줄 요약이고, 펼침은 사용자가 고른 때만 남는다. */
const sidebarUsageDensityStore = localStore<SidebarUsageDensity>({
  key: SIDEBAR_USAGE_DENSITY_KEY,
  parse: (stored) => (stored === "detailed" ? "detailed" : "compact"),
  serialize: (density) => density,
  fallback: () => "compact",
});
const catalogDiscoveryStore = localStore<string[]>({
  key: CATALOG_DISCOVERY_REQUEST_KEY,
  parse: parseDiscoveryRequests,
  serialize: (requests) => JSON.stringify(requests),
  fallback: () => [],
});
/**
 * 마지막으로 보던 화면. 스킬 화면의 모드, 문서 사이드바, UI 언어는 이미 새로고침을 넘어
 * 유지되는데 상위 화면만 매번 대시보드로 돌아가 저장 범위가 어긋나 있었다. 프런트가 갱신돼
 * stale-shell 재로드가 걸릴 때도 보던 자리를 잃는다.
 */
const activeViewStore = localStore<ViewId | null>({
  key: ACTIVE_VIEW_KEY,
  parse: (stored) => isViewId(stored) ? stored : null,
  serialize: (view) => view ?? "",
  fallback: () => null,
});

/**
 * 테마는 저장과 함께 문서와 창 크롬에 곧바로 적용해야 값과 화면이 어긋나지 않는다.
 */
function persistThemeMode(mode: ThemeMode): void {
  saveThemeMode(mode);
  applyThemeMode(mode);
  if (hasTauriRuntime()) {
    // 창 크롬(타이틀바)도 콘텐츠 테마와 맞춘다. auto는 OS 설정을 따르도록 되돌린다.
    void getCurrentWindow().setTheme(mode === "auto" ? null : mode).catch(() => undefined);
  }
}

/** 악센트도 테마와 같이 저장과 적용을 함께 한다. */
function persistAccentColor(color: AccentColor): void {
  saveAccentColor(color);
  applyAccentColor(color);
}

/**
 * 새로고침을 넘어 유지되는 화면 설정 하나. 불러오기와 저장을 선언 자리에서 짝지어 두면
 * 저장 효과를 따로 늘어놓지 않아도 되고, 설정을 하나 더 늘릴 때 저장을 빠뜨릴 자리가
 * 없어진다. 저장만으로 끝나지 않는 값(테마·악센트)은 persist가 적용까지 함께 한다.
 */
function useStoredState<T>(load: () => T, persist: (value: T) => void): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(load);
  useEffect(() => { persist(value); }, [persist, value]);
  return [value, setValue];
}

/**
 * 저장된 화면으로 시작해도 되는지. 메뉴에서 숨긴 화면으로 복원하면 주 메뉴에 짚이는 자리가
 * 없는 화면이 열려, 사용자는 자기가 숨긴 화면을 왜 보고 있는지 알 수 없다. 설정은 숨김
 * 대상이 아니라 언제나 허용한다.
 */
function restorableView(stored: ViewId | null, preferences: NavigationPreferences): ViewId | null {
  if (!stored) return null;
  if (stored === "settings") return stored;
  return preferences.hidden.includes(stored as ConfigurableViewId) ? null : stored;
}
/**
 * 본 창이 시작할 화면. 저장된 화면을 복원할 수 없으면(없음·숨김) 고정값 대시보드가 아니라
 * 메뉴에 보이는 첫 화면으로 떨어진다 — 대시보드도 숨길 수 있는 메뉴라, 고정값으로 두면
 * 바로 위 숨김 판정이 막은 일이 다음 줄에서 그대로 일어난다.
 */
function initialMainView(stored: ViewId | null, preferences: NavigationPreferences): ViewId {
  return restorableView(stored, preferences) ?? firstVisibleView(preferences);
}
const EMPTY_CHAT_ATTENTION: ChatAttentionSnapshot = { items: [], unreadCount: 0, pendingCount: 0 };
/** 시스템 에이전트를 고르지 않은 AIA 트리거와 설정 화면에 함께 쓰는 안내. */
/** 세션·AIA·채팅 뷰 알림 타깃이 공통으로 갖는, 해제 판단에 쓰이는 필드. */
interface AttentionTarget {
  attentionId: string;
  markRead: boolean;
  requestId: number;
}

const AIA_DISABLED_HINT_KO = "시스템 에이전트가 설정되지 않았습니다. 설정에서 시스템 에이전트를 선택하세요.";
const AIA_DISABLED_HINT_EN = "No system agent is configured. Choose a system agent in Settings.";

// 폴링 응답 내용이 같으면 기존 state 참조를 유지해, 마운트된(숨겨진) 뷰 전체가 매 폴링마다 재조정되는 것을 막는다.
function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * 위 판정을 그대로 쓰는 setState 갱신자. 내용이 같으면 현재 참조를, 다르면 새 값을 올린다.
 * `replace`는 내용이 같아도 다시 그려야 하는 경우(예: 경과 시간 표시)에 쓴다.
 */
function keepIfSame<T>(next: T, replace = false): (current: T | null) => T {
  return (current) => (current && !replace && sameJson(current, next) ? current : next);
}

// 번역 진행 revision·updatedAt은 백엔드가 스캔할 때마다 새 값을 반환하므로,
// 화면 표시와 번역 재조회에 실제로 영향을 주는 내용만 비교한다.
function automationRenderPayload(snapshot: SystemAutomationSnapshot): string {
  const stripTime = ({ updatedAt: _updatedAt, ...status }: TranslationStatus) => status;
  const { revision: _revision, uiTranslation, skills, agents, artifacts, ...rest } = snapshot;
  return JSON.stringify({
    ...rest,
    uiTranslation: stripTime(uiTranslation),
    skills: stripTime(skills),
    agents: stripTime(agents),
    artifacts: stripTime(artifacts),
  });
}

// 전역 폴링 setState가 무거운 뷰(세션 상세 트랜스크립트 등)를 다시 그리지 않도록 뷰 단위로 memo한다.
const MemoDashboardView = memo(DashboardView);
/**
 * 화면 번들은 필요할 때 내려받고, 받은 뒤에는 memo로 감싸 다른 화면의 갱신에 휩쓸리지
 * 않게 한다. 화면마다 같은 모양을 열두 번 적던 것을 이 한 벌로 모은다.
 */
function lazyMemoView<K extends string, P>(load: () => Promise<Record<K, ComponentType<P>>>, name: K) {
  return lazy(async () => ({ default: memo(await load().then((module) => module[name])) }));
}
const MemoChatView = lazyMemoView(() => import("./components/ChatView"), "ChatView");
const MemoSessionsView = lazyMemoView(() => import("./components/SessionsView"), "SessionsView");
const MemoDocsView = lazyMemoView(() => import("./components/DocsView"), "DocsView");
const MemoInstructionsView = lazyMemoView(() => import("./components/InstructionsView"), "InstructionsView");
const MemoSkillsView = lazyMemoView(() => import("./components/SkillsView"), "SkillsView");
const MemoAgentsView = lazyMemoView(() => import("./components/AgentsView"), "AgentsView");
const MemoArtifactsView = lazyMemoView(() => import("./components/ArtifactsView"), "ArtifactsView");
const MemoWorkflowsView = lazyMemoView(() => import("./components/WorkflowsView"), "WorkflowsView");
const MemoAddonsView = lazyMemoView(() => import("./components/AddonsView"), "AddonsView");
const MemoStorageView = lazyMemoView(() => import("./components/StorageView"), "StorageView");
const MemoSettingsView = lazyMemoView(() => import("./components/SettingsView"), "SettingsView");
const AiaChatPopup = lazy(() => import("./components/AiaChatPopup").then((module) => ({ default: module.AiaChatPopup })));
const CliConnectionDrawer = lazy(() => import("./components/CliConnectionDrawer").then((module) => ({ default: module.CliConnectionDrawer })));

/**
 * 화면 하나가 사이드바에서 쓰는 것 — 아이콘, 메뉴 이름, 헤더 제목 — 을 한 줄에 모은다.
 * 세 곳에 흩어 두면 화면을 추가할 때 한 곳을 빠뜨려도 타입이 잡아 주지 못한다.
 * `title`은 메뉴 이름과 헤더 제목이 다른 화면에만 둔다.
 */
const NAVIGATION: Record<ViewId, { icon: LucideIcon; label: [string, string]; title?: [string, string] }> = {
  dashboard: { icon: LayoutDashboard, label: ["대시보드", "Dashboard"] },
  chat: { icon: Sparkles, label: ["채팅", "Chat"] },
  sessions: { icon: MessagesSquare, label: ["세션", "Sessions"] },
  docs: { icon: FileText, label: ["문서", "Documents"] },
  instructions: { icon: BookOpen, label: ["지침", "Instructions"], title: ["에이전트 지침", "Agent instructions"] },
  skills: { icon: Puzzle, label: ["스킬", "Skills"] },
  agents: { icon: Bot, label: ["에이전트", "Agents"] },
  artifacts: { icon: Layers, label: ["아티팩트", "Artifacts"] },
  workflows: { icon: Workflow, label: ["워크플로", "Workflows"], title: ["워크플로 관리", "Workflow management"] },
  addons: { icon: PackagePlus, label: ["애드온", "Add-ons"] },
  storage: { icon: HardDrive, label: ["저장소", "Storage"] },
  settings: { icon: Settings, label: ["설정", "Settings"] },
};

/** 계정 사용량 병렬 조회가 겹치지 않게 막는 키. 계정 하나가 아니라 호출 단위로 잡는다. */
/**
 * 마운트된 채 유지되는 화면(채팅·설정·워크플로·애드온)에 "이 탭을 열어라"를 내려 보내는
 * 요청 상태. 같은 탭을 다시 열어도 화면이 알아채도록 요청마다 새 번호를 매기며, 번호는
 * 네 화면이 공유하는 하나의 순번(nextRequestId)에서 받아 서로 겹치지 않는다.
 */
function useTabRequest<T extends string>(nextRequestId: () => number): [TabRequest<T> | null, (tab: T) => void] {
  const [request, setRequest] = useState<TabRequest<T> | null>(null);
  const open = useCallback((tab: T) => {
    setRequest({ tab, requestId: nextRequestId() });
  }, [nextRequestId]);
  return [request, open];
}

function App() {
  const { locale, setLocale, text } = useI18n();
  const [snapshot, setSnapshot] = useState<ManagerSnapshot | null>(null);
  const [catalogHealth, setCatalogHealth] = useState<CatalogHealth | null>(null);
  const [automation, setAutomation] = useState<SystemAutomationSnapshot | null>(null);
  const [accounts, setAccounts] = useState<AccountSnapshot | null>(null);
  const [schedulerSnapshot, setSchedulerSnapshot] = useState<SchedulerSnapshot | null>(null);
  // 채팅·설정 화면은 마운트된 채 유지되므로, 특정 탭을 열려면 requestId를 새로 매긴 요청을
  // 내려 보낸다(대시보드 반복 일정, 사이드바 CLI 상태, AIA 화면 안내가 쓴다).
  const tabRequestSeq = useRef(0);
  const nextRequestId = useCallback(() => (tabRequestSeq.current += 1), []);
  const [chatTabRequest, requestChatTab] = useTabRequest<ChatTab>(nextRequestId);
  const [settingsTabRequest, requestSettingsTab] = useTabRequest<SettingsTabId>(nextRequestId);
  const [workflowsTabRequest, requestWorkflowsTab] = useTabRequest<WorkflowsTabId>(nextRequestId);
  const [addonsTabRequest, requestAddonsTab] = useTabRequest<AddonsTabId>(nextRequestId);
  const [systemAgentNoticeRequest, setSystemAgentNoticeRequest] = useState<number | null>(null);
  // 팝아웃 창은 주소 쿼리로 열 대상을 받아 그 화면만 바로 연다. 최초 로드 시 한 번만 해석한다.
  const [popoutRequest] = useState(() => parsePopoutRequest(window.location.search));
  // 팝아웃 창은 열 대상이 주소로 정해져 있으므로 저장된 화면을 보지 않는다.
  const [initialView] = useState<ViewId>(() => popoutRequest
    ? (popoutRequest.kind === "chat" ? "chat" : popoutRequest.kind === "aia" ? "dashboard" : "sessions")
    : initialMainView(activeViewStore.load(), loadNavigationPreferences()));
  const [view, setView] = useState<ViewId>(initialView);
  const [mountedViews, setMountedViews] = useState<Set<ViewId>>(() => new Set([initialView]));
  const [resourceRepositoryRevision, setResourceRepositoryRevision] = useState(0);
  // 새로 감지된 프로젝트의 초기값(활성 유지/제외)을 묻는 알림. "나중에"로 닫은 프로젝트의
  // 경로를 기억해, 그중 하나가 설정에서 정리돼 대기 집합이 줄기만 해도 다시 띄우지 않고,
  // 미뤄 둔 적 없는 프로젝트가 더 감지될 때만 다시 띄운다. 집합 키 한 줄로 비교하면
  // 줄어든 집합도 "달라진 집합"이 되어 방금 미룬 알림창이 되살아난다.
  const [dismissedPendingProjectPaths, setDismissedPendingProjectPaths] = useState<ReadonlySet<string>>(() => new Set());
  const [pendingProjectBusy, setPendingProjectBusy] = useState<string | null>(null);
  const [messageDisplayMode, setMessageDisplayMode] = useStoredState<MessageDisplayMode>(messageDisplayModeStore.load, messageDisplayModeStore.save);
  const [navigationPreferences, setNavigationPreferences] = useStoredState<NavigationPreferences>(loadNavigationPreferences, saveNavigationPreferences);
  // 대화 원문 표시 범위는 세션 상세와 채팅이 함께 쓴다. 한쪽에서 바꾸면 다른 쪽도 같은 범위가
  // 되도록 messageDisplayMode와 같은 방식으로 App이 소유한다.
  const [transcriptLimit, setTranscriptLimit] = useStoredState<SessionTranscriptLimit>(sessionTranscriptLimitStore.load, sessionTranscriptLimitStore.save);
  const [themeMode, setThemeMode] = useStoredState<ThemeMode>(loadThemeMode, persistThemeMode);
  const [sidebarUsageDensity, setSidebarUsageDensity] = useStoredState<SidebarUsageDensity>(sidebarUsageDensityStore.load, sidebarUsageDensityStore.save);
  // Antigravity는 계정 레지스트리에 없어 계정 스냅샷으로 오지 않는다. 사이드바 카드에 함께
  // 세우기 위해 따로 읽고, CLI가 탐지된 기기에서만 두드린다.
  const [antigravityUsage, setAntigravityUsage] = useState<AccountUsageView | null>(null);
  const [accentColor, setAccentColor] = useStoredState<AccentColor>(loadAccentColor, persistAccentColor);
  const [selectedSession, setSelectedSession] = useState<SessionSummary | null>(null);
  const [closedAiaBubbleKey, setClosedAiaBubbleKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const [statusRefreshing, setStatusRefreshing] = useState(false);
  const [appRefreshing, setAppRefreshing] = useState(false);
  const [setupProviderId, setSetupProviderId] = useState<ProviderId | null>(null);
  const [aiaOpen, setAiaOpen] = useState(popoutRequest?.kind === "aia");
  const [aiaMounted, setAiaMounted] = useState(popoutRequest?.kind === "aia");
  // 팝업을 닫아 둔 채 자동 요청이 돌 때도 상단바에서 진행 상황이 보여야 한다.
  const [aiaBusy, setAiaBusy] = useState(false);
  const aiaTriggerRef = useRef<HTMLButtonElement>(null);
  const [aiaAutoPrompt, setAiaAutoPrompt] = useState<AiaAutoPrompt | null>(null);
  const [aiaSuggestionCatalog, setAiaSuggestionCatalog] = useState<AiaSuggestionCatalog | null>(null);
  const [aiaSuggestionHistory, setAiaSuggestionHistory] = useState<AiaSuggestionHistory>(aiaSuggestionHistoryStore.load);
  const [aiaSuggestionNow, setAiaSuggestionNow] = useState(() => Date.now());
  const [aiaSkillChanges, setAiaSkillChanges] = useState<AiaSkillChangeState>(aiaSkillChangeStore.load);
  const aiaAutoPromptSeq = useRef(0);
  // AIA 팝업을 열고 요청 메시지를 자동 전송한다 (실행설정 스키마 디스커버리 등).
  // 시스템 에이전트를 고르지 않아 AIA가 꺼져 있으면 전달할 런타임이 없으므로 무시한다.
  const requestAiaPrompt = useCallback((text: string) => {
    if (!aiaRuntimeProvider(automationRef.current)) return;
    aiaAutoPromptSeq.current += 1;
    setAiaAutoPrompt({ text, requestId: aiaAutoPromptSeq.current });
    setAiaOpen(true);
  }, []);
  const snapshotRef = useRef<ManagerSnapshot | null>(null);
  const automationRef = useRef<SystemAutomationSnapshot | null>(null);
  const completedRunIds = useRef<Set<string> | null>(null);
  const sessionCatalogSyncs = useRef(new Map<string, Promise<void>>());
  // 재시도 예산을 다 쓴 색인 대상. 기록을 남기지 못한 실행은 목록에 절대 나타나지
  // 않으므로, 표시해 두지 않으면 폴링마다 같은 요청을 영구히 다시 만든다.
  const abandonedSessionSyncs = useRef(new Set<string>());
  const catalogReconciliation = useRef<Promise<void> | null>(null);
  // 반복 요청도 같다. 10초 폴링이 화면에 먼저 올린 토글 상태를 되돌리지 못하게 막는다.
  const schedulerRevision = useRef(0);
  const bulkUsageRefreshRunning = useRef(false);
  const usageResetSignatureRef = useRef("");
  const wasReconnecting = useRef(false);

  // 웹 모드에서 원격 서버에 닿지 못한 실패는 오류 배너 대신 재연결 상태로 표시한다.
  const reportFailure = useCallback((cause: unknown) => {
    if (cause instanceof RemoteConnectionError) {
      setReconnecting(true);
      if (!snapshotRef.current) setError(cause.message);
      return;
    }
    setError(errorText(cause));
  }, []);

  const refresh = useCallback(async (propagateError = false) => {
    setError(null);
    try {
      const next = normalizeManagerSnapshot(await getManagerSnapshot());
      snapshotRef.current = next;
      setSnapshot(next);
      setReconnecting(false);
      setSelectedSession((selected) => selected ? next.sessions.find((session) => session.source === selected.source && session.id === selected.id) ?? null : null);
      return next;
    } catch (cause) {
      reportFailure(cause);
      if (propagateError) throw new Error(errorText(cause));
      return null;
    }
  }, [reportFailure]);

  const reconcileSessionList = useCallback(() => {
    if (catalogReconciliation.current) return catalogReconciliation.current;
    const task = (async () => {
      try {
        const update = await reconcileSessionCatalog();
        if (snapshotRef.current?.sessionCatalogRevision !== update.revision) {
          await refresh();
        }
      } catch (cause) {
        // 다른 갱신이 이미 같은 조정을 돌리고 있다는 뜻이다. 배경 주기 갱신과 상태
        // 폴링이 결과를 가져오므로 오류로 올리지 않는다.
        if (cause instanceof BackendBusyError) return;
        reportFailure(cause);
      }
    })().finally(() => {
      catalogReconciliation.current = null;
    });
    catalogReconciliation.current = task;
    return task;
  }, [refresh, reportFailure]);

  const syncSessionCatalog = useCallback((source: ProviderId, id: string) => {
    const key = sessionSyncKey(source, id);
    const activeSync = sessionCatalogSyncs.current.get(key);
    if (activeSync) return activeSync;
    const sync = (async () => {
      let lastError: unknown = null;
      for (const delay of SESSION_SYNC_DELAYS_MS) {
        if (delay > 0) await new Promise((resolve) => window.setTimeout(resolve, delay));
        try {
          const update = await refreshSessionCatalog(source, id);
          const next = snapshotRef.current?.sessionCatalogRevision === update.revision
            ? snapshotRef.current
            : await refresh();
          if (next?.sessions.some((session) => session.source === source && session.id === id)) return;
        } catch (cause) {
          // 진행 중 갱신과 겹친 것은 실패가 아니다. 남은 예산으로 다시 본다.
          if (!(cause instanceof BackendBusyError)) lastError = cause;
        }
      }
      // 예산을 다 썼다. 기록을 남기지 못한 실행일 수 있으므로 다시 쫓지 않는다.
      abandonedSessionSyncs.current.add(sessionSyncKey(source, id));
      if (lastError) {
        reportFailure(lastError);
      }
    })().finally(() => {
      sessionCatalogSyncs.current.delete(key);
    });
    sessionCatalogSyncs.current.set(key, sync);
    return sync;
  }, [refresh, reportFailure]);

  useEffect(() => { void refresh(); }, [refresh]);

  // 세션 팝아웃 창: 스냅샷이 준비되면 대상 세션을 찾아 상세 화면을 바로 연다.
  const popoutSessionHandled = useRef(false);
  useEffect(() => {
    if (!snapshot || popoutRequest?.kind !== "session" || popoutSessionHandled.current) return;
    popoutSessionHandled.current = true;
    const { source, sessionId } = popoutRequest;
    const find = () => snapshotRef.current?.sessions.find((candidate) => candidate.source === source && candidate.id === sessionId) ?? null;
    void (async () => {
      let session = find();
      if (!session) {
        await syncSessionCatalog(source, sessionId);
        session = find();
      }
      if (!session) {
        setError("요청한 세션을 세션 목록에서 찾지 못했습니다.");
        return;
      }
      setSelectedSession(session);
    })().catch((cause: unknown) => setError(errorText(cause)));
  }, [snapshot, popoutRequest, syncSessionCatalog]);

  // 팝아웃 창의 임시 제목. 대상 이름을 알기 전까지만 쓰고, 화면이 대상을 열면
  // usePopoutWindowTitle이 실제 이름으로 바꾼다. 나중에 다시 덮지 않도록 한 번만 설정한다.
  useEffect(() => {
    if (!popoutRequest) return;
    document.title = popoutRequest.kind === "aia" ? "AIA · Agent Manager" : popoutRequest.kind === "chat" ? "채팅 · Agent Manager" : "세션 · Agent Manager";
  }, []);

  // AIA의 세션 상태는 첫 사용 뒤 계속 보존하되, 사용 전에는 큰 채팅 번들을 내려받지 않는다.
  useEffect(() => {
    if (aiaOpen || aiaAutoPrompt) setAiaMounted(true);
  }, [aiaAutoPrompt, aiaOpen]);

  // 연결이 복구되면 끊긴 사이의 변경을 다시 읽고, 남아 있던 일시 오류 배너도 함께 정리한다.
  useEffect(() => {
    if (wasReconnecting.current && !reconnecting) void refresh();
    wasReconnecting.current = reconnecting;
  }, [reconnecting, refresh]);

  /**
   * 계정별 사용량 일괄 조회. 계정별 조회가 백엔드에서 동시에 돌고 결과는 한 번만
   * 오는데 그 응답이 전체 스냅샷이라, 두 벌이 겹치면 서로의 결과를 덮어쓴다.
   * 그래서 진행 중이면 건너뛴다. 계정 한 곳의 실패는 그 계정 카드의 오류로 남으므로
   * 여기서는 삼키고 호출부의 흐름을 막지 않는다.
   */
  const runBulkUsageRefresh = useCallback(async (force = false) => {
    if (bulkUsageRefreshRunning.current) return;
    bulkUsageRefreshRunning.current = true;
    try {
      const updated = await refreshProviderAccountUsages(undefined, force);
      setAccounts(keepIfSame(updated));
    } catch {
      // 전체 조회가 실패해도 호출부는 성공으로 둔다.
    } finally {
      bulkUsageRefreshRunning.current = false;
    }
  }, []);

  // 폴링 주기마다 실행되므로 accounts state 변화에 의존하지 않고 최신 응답으로 직접 검사한다.
  // 자격증명이 계정별로 갈려 있어 계정마다 사용량을 조회할 수 있게 됐으므로, 갱신이
  // 필요한 계정이 하나라도 있으면 계정별 응답을 순차로 받는 대신 한 번의 병렬 조회로
  // 받는다. 계정별 응답이 각각 전체 스냅샷이라 순차 호출은 서로의 결과를 덮어쓴다.
  const refreshStaleAccountUsage = useCallback((current: AccountSnapshot) => {
    const now = Date.now();
    const stale = current.accounts.filter((account) => {
      // 활성 계정과 런타임이 붙은 계정만 사용량이 올라갈 수 있다. 아무것도 돌지 않는
      // 계정을 같은 빈도로 두드리면 공급자 API 호출만 늘고 얻는 것이 없다.
      const staleBefore = now - usageRefreshInterval(account);
      // 최근에 조회했더라도 초기화 시각을 지났으면 실제 사용량을 곧바로 다시 확인한다.
      const fresh = (account.usage.updatedAt ?? 0) > staleBefore
        && !usageResetElapsedSinceUpdate(account.usage, now);
      return accountUsageDisplayState(account, now).canRefresh
        && !fresh
        && !usageRefreshDeferred(account.usage, now);
    });
    // 공유 홈에만 든 로그인(홈 계정)도 같은 호출로 읽는다. 등록 계정이 하나도 없는
    // 공급자에서는 위 목록이 늘 비어 있어, 여기서 함께 보지 않으면 홈 계정 사용량이
    // 영영 조회되지 않는다.
    const homeDue = current.providers.some((provider) => homeUsageRefreshDue(provider.home, now));
    if (stale.length === 0 && !homeDue) return;
    void runBulkUsageRefresh();
  }, [runBulkUsageRefresh]);

  const antigravityDetected = Boolean(snapshot?.status.providers.some((provider) => (
    provider.provider === "antigravity" && provider.cli.detected
  )));
  /**
   * 사이드바용 Antigravity 사용량. 조회 실패는 카드에서 이 공급자를 빼는 것으로 끝낸다 —
   * 미설치·미로그인이 정상인 기기가 있고, 계정 사용량은 멀쩡하므로 카드 전체 오류로 올리지
   * 않는다. 값이 같으면 참조를 유지해 사이드바가 헛되이 다시 그려지지 않게 한다.
   */
  const pollAntigravityUsage = useCallback(async () => {
    if (!antigravityDetected) return;
    try {
      // 캐시 우선: 폴링마다 CLI(agy)를 띄우지 않는다. 첫 폴링은 캐시가 비어 값이 없고
      // 백엔드가 뒤에서 채운 뒤 다음 폴링부터 카드에 오른다.
      const next = await getAntigravityUsage("cachedFirst");
      setAntigravityUsage((current) => (
        current && JSON.stringify(current) === JSON.stringify(next) ? current : next
      ));
    } catch {
      setAntigravityUsage(null);
    }
  }, [antigravityDetected]);
  usePoll(pollAntigravityUsage, ANTIGRAVITY_USAGE_POLL_MS, { enabled: antigravityDetected });

  /**
   * 사이드바 상태 카드의 통합 새로고침. 폴링을 기다리지 않고 CLI 탐지 스냅샷과 활성 계정
   * 사용량을 한 번에 다시 읽는다. 사용량은 계정별 응답이 전체 스냅샷이라 순차로 갱신해
   * 동시 응답이 서로의 결과를 덮어쓰지 않게 한다.
   */
  const refreshStatusCard = useCallback(async () => {
    setStatusRefreshing(true);
    try {
      // Antigravity 조회는 CLI를 띄워 수십 초 걸릴 수 있어 기다리지 않는다. 값이 오면
      // 그때 카드가 갱신되고, 버튼은 계정 사용량 갱신이 끝나는 대로 되살아난다.
      void pollAntigravityUsage();
      const [, latest] = await Promise.all([refresh(), getProviderAccounts()]);
      setAccounts(keepIfSame(latest));
      const now = Date.now();
      const refreshable = latest.accounts.some((account) => accountUsageDisplayState(account, now).canRefresh);
      // 사용자가 직접 누른 새로고침이므로 계정별 갱신 주기를 무시한다. 그러지 않으면
      // 방금 조회한 계정이 섞여 있을 때 버튼이 아무 일도 안 한 것처럼 보인다.
      if (refreshable) await runBulkUsageRefresh(true);
    } catch (cause) {
      reportFailure(cause);
    } finally {
      setStatusRefreshing(false);
    }
  }, [pollAntigravityUsage, refresh, reportFailure, runBulkUsageRefresh]);

  /**
   * 로고 클릭 = 앱 데이터 새로고침. 스냅샷·계정·사용량은 사이드바 상태 카드와 같은
   * 경로로 다시 읽고, 세션 목록은 색인 조정까지 밀어 목록이 실제 파일을 따라가게 한다.
   * 두 경로 모두 자체적으로 중복 실행을 막고 실패를 스스로 보고하므로 여기서는
   * 진행 표시만 맡는다. 화면을 다시 불러오지는 않아 작성 중인 입력은 남는다.
   */
  const refreshApp = useCallback(async () => {
    setAppRefreshing(true);
    try {
      await Promise.all([refreshStatusCard(), reconcileSessionList()]);
    } finally {
      setAppRefreshing(false);
    }
  }, [reconcileSessionList, refreshStatusCard]);

  const pollAccounts = useCallback(async () => {
    try {
      const next = await getProviderAccounts();
      // 데이터가 같아도 초기화 시각 경과로 표시가 달라지면 새 객체로 교체해 다시 그린다.
      const resetSignature = elapsedResetSignature(next, Date.now());
      const resetSignatureChanged = usageResetSignatureRef.current !== resetSignature;
      usageResetSignatureRef.current = resetSignature;
      setAccounts(keepIfSame(next, resetSignatureChanged));
      refreshStaleAccountUsage(next);
      setReconnecting(false);
      if (snapshotRef.current) setError(null);
    } catch (cause) {
      reportFailure(cause);
      // 폴링 루프가 백오프하도록 실패를 그대로 전달한다.
      throw cause;
    }
  }, [refreshStaleAccountUsage, reportFailure]);
  usePoll(pollAccounts, 5_000);

  const pollAutomation = useCallback(async () => {
    try {
      const next = await getSystemAutomationSnapshot();
      const previous = automationRef.current;
      automationRef.current = next;
      if (!previous || automationRenderPayload(previous) !== automationRenderPayload(next)) {
        setAutomation(next);
        setLocale(next.settings.language.code, next.uiMessages);
      }
      if (previous && previous.resourceCatalogRevision !== next.resourceCatalogRevision) {
        await refresh();
      }
    } catch (cause) {
      if (cause instanceof RemoteConnectionError) {
        setReconnecting(true);
      } else if (!automationRef.current) {
        setError(errorText(cause));
      }
      throw cause;
    }
  }, [refresh, setLocale]);
  usePoll(pollAutomation, 3_000);

  useEffect(() => {
    if (!hasTauriRuntime()) return undefined;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen("toggle-scheduler-pause", () => {
      void getSchedulerSnapshot()
        .then((current) => setSchedulesPaused(!current.paused))
        .then(setSchedulerSnapshot)
        .catch(reportFailure);
    })
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [reportFailure]);

  const pollScheduler = useCallback(async () => {
    const revision = schedulerRevision.current;
    const scheduler = await getSchedulerSnapshot();
    // 이 응답을 기다리는 사이 토글을 눌렀으면, 서버가 그 요청을 반영하기 전에 뜬 목록이다.
    // 그대로 올리면 방금 바꾼 스위치가 되돌아간다. 목록만 버리고 아래 실행 추적은 그대로 한다.
    if (schedulerRevision.current === revision) {
      setSchedulerSnapshot(keepIfSame(scheduler));
    }
    const completed = scheduler.runs.filter((run) => run.status === "completed" && run.providerSessionId);
    const nextIds = new Set(completed.map((run) => run.id));
    const previousIds = completedRunIds.current;
    completedRunIds.current = nextIds;
    const sourceByScheduleId = new Map(scheduler.schedules.map((schedule) => [schedule.id, schedule.source]));
    const sessions = snapshot?.sessions ?? [];
    // 색인될 수 없는 완료 실행(기록을 남기지 못한 실행)은 포기 목록에서 걸러 낸다.
    // 걸러 내지 않으면 폴링마다 같은 갱신 요청이 다시 생겨 백엔드 대기가 쌓인다.
    const pending = unindexedRunTargets(
      completed,
      sourceByScheduleId,
      (source, id) => sessions.some((session) => session.source === source && session.id === id),
      abandonedSessionSyncs.current,
    );
    const hasNewCompletion = Boolean(previousIds && completed.some((run) => !previousIds.has(run.id)));
    if (hasNewCompletion || pending.length > 0) {
      await Promise.all(pending.map((target) => syncSessionCatalog(target.source, target.id)));
    }
    // 실패는 전역 오류로 올리지 않는다. usePoll이 그대로 받아 백오프한다.
  }, [snapshot?.sessions, syncSessionCatalog]);
  const refreshScheduler = usePoll(pollScheduler, 10_000);
  // 반복 요청 화면이 스냅샷을 직접 갈아 끼운다. 토글은 화면을 먼저 바꾸고, 서버 응답이
  // 오면 그 값으로 다시 덮는다. 목록 전체를 다시 받지 않으므로 왕복이 한 번으로 줄고,
  // 세대 번호가 올라가 진행 중이던 폴링 응답은 버려진다.
  const applySchedulerSnapshot = useCallback((update: (current: SchedulerSnapshot) => SchedulerSnapshot) => {
    schedulerRevision.current += 1;
    setSchedulerSnapshot((current) => current ? update(current) : current);
  }, []);


  // 갱신이 멈춰도 스냅샷 읽기는 성공하므로, 목록이 언제 기준인지는 이 상태로만 알 수
  // 있다. 배경 주기 갱신이 색인을 올렸는지도 개정 번호로 알아채 화면을 따라가게 한다.
  const pollCatalogHealth = useCallback(async () => {
    const health = await getCatalogHealth();
    setCatalogHealth(keepIfSame(health));
    if (snapshotRef.current && snapshotRef.current.sessionCatalogRevision !== health.sessionRevision) {
      await refresh();
    }
  }, [refresh]);
  usePoll(pollCatalogHealth, 15_000);

  const pollAiaSuggestionCatalog = useCallback(async () => {
    const next = await getAiaSuggestionCatalog();
    setAiaSuggestionCatalog((current) => current?.contentDigest === next.contentDigest ? current : next);
    // 지연 리마인드와 만료 조건은 모델 호출 없이 분 단위로 다시 판단한다.
    setAiaSuggestionNow(Date.now());
  }, []);
  usePoll(pollAiaSuggestionCatalog, 60_000, { enabled: !popoutRequest });

  useEffect(() => {
    if (view !== "sessions" || !snapshotRef.current) return undefined;
    const timer = window.setTimeout(() => { void reconcileSessionList(); }, 0);
    return () => window.clearTimeout(timer);
  }, [reconcileSessionList, view]);

  // CLI가 업데이트되면 AIA가 제안한 모델·추론 카탈로그가 그 버전보다 오래된 것이 되고,
  // 제안이 아예 없는 공급자(Claude)는 처음부터 재조사 대상이다. 자동 재조사가 켜져
  // 있으면 AIA에게 재조사를 맡겨, 앱을 새로 배포하지 않고도 최신 모델·추론이 따라온다.
  //
  // 모델·추론 카탈로그가 오래된 공급자를 찾아 AIA에게 재조사를 맡긴다. 탐지된 CLI가
  // 바뀌거나 자동 재조사 설정이 켜질 때만 판단하며, 같은 CLI 버전에서는 한 번만 묻는다.
  // 보낸 기록은 저장소에 남긴다. 메모리 ref로만 두면 재마운트·팝아웃 창마다 같은 요청을
  // 다시 보내고, AIA가 답하지 못한 버전을 앱을 켤 때마다 되묻게 된다. CLI가 업데이트되면
  // 키가 바뀌어 다시 묻는다.
  const detectedProviderKey = snapshot?.status.providers
    .filter((provider) => provider.cli.detected)
    .map((provider) => provider.provider)
    .join(",") ?? "";
  const catalogAutoDiscovery = automation?.settings.catalogAutoDiscovery !== false
    && Boolean(aiaRuntimeProvider(automation));
  useEffect(() => {
    if (!catalogAutoDiscovery || !detectedProviderKey) return undefined;
    let disposed = false;
    const sources = detectedProviderKey.split(",") as ProviderId[];
    // 카탈로그를 읽지 못하면(원격 연결 끊김 등) 이번 판단만 건너뛴다.
    void Promise.all(sources.map((source) => refreshProviderOptions(source).catch(() => null)))
      .then((options) => {
        if (disposed) return;
        // 다른 창이 방금 보냈을 수도 있으므로 판단 직전에 기록을 다시 읽는다.
        const requested = catalogDiscoveryStore.load();
        const stale = staleCatalogSources(options)
          .filter((item) => !requested.includes(discoveryRequestKey(item)));
        if (stale.length === 0) return;
        catalogDiscoveryStore.save(rememberDiscoveryRequests(requested, stale.map(discoveryRequestKey)));
        requestAiaPrompt(schemaDiscoveryPrompt(stale.map((item) => item.source)));
      });
    return () => { disposed = true; };
  }, [catalogAutoDiscovery, detectedProviderKey, requestAiaPrompt]);

  const projectOptions = useMemo(() => collectProjects(snapshot?.sessions ?? []), [snapshot?.sessions]);
  const pendingProjects = useMemo(() => snapshot?.pendingProjects ?? [], [snapshot?.pendingProjects]);
  useEffect(() => {
    if (!snapshot || popoutRequest) return;
    void notifyNewProjects(pendingProjects);
  }, [pendingProjects, popoutRequest, snapshot]);
  // 공통 저장소 경로·프로젝트 활성여부가 바뀌면 스킬·지침 화면이 다시 읽고 스냅샷도 다시 받는다.
  const invalidateResourceViews = useCallback(() => {
    setResourceRepositoryRevision((current) => current + 1);
    void refresh();
  }, [refresh]);
  const decidePendingProject = useCallback(async (entry: ProjectRegistryEntry, active: boolean) => {
    setPendingProjectBusy(entry.path);
    try {
      await setProjectActive({ path: entry.path, active });
      invalidateResourceViews();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setPendingProjectBusy(null);
    }
  }, [invalidateResourceViews]);
  const keepAllPendingProjects = useCallback(async () => {
    setPendingProjectBusy("*");
    try {
      for (const entry of pendingProjects) {
        await setProjectActive({ path: entry.path, active: true });
      }
      invalidateResourceViews();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setPendingProjectBusy(null);
    }
  }, [invalidateResourceViews, pendingProjects]);
  const showNewProjectsModal = Boolean(snapshot) && !popoutRequest
    && pendingProjects.some((entry) => !dismissedPendingProjectPaths.has(entry.path));
  const deferPendingProjects = useCallback(() => {
    setDismissedPendingProjectPaths((current) => new Set([...current, ...pendingProjects.map((entry) => entry.path)]));
  }, [pendingProjects]);
  const modelOptions = useMemo(() => collectRecentModels(snapshot?.sessions ?? []), [snapshot?.sessions]);

  const activateView = useCallback((nextView: ViewId) => {
    setMountedViews((current) => {
      if (current.has(nextView)) return current;
      const next = new Set(current);
      next.add(nextView);
      return next;
    });
    // 팝아웃 창의 화면 선택은 그 창만의 것이라 저장하지 않는다. 저장하면 본 창이 다음
    // 실행에서 팝아웃이 열었던 화면으로 시작한다.
    if (!popoutRequest) activeViewStore.save(nextView);
    setView(nextView);
  }, [popoutRequest]);

  const openSystemAgentSettings = useCallback(() => {
    requestSettingsTab("connections");
    setSystemAgentNoticeRequest(nextRequestId());
    activateView("settings");
  }, [activateView, nextRequestId, requestSettingsTab]);

  // 알림창의 상태·폴링·라우팅은 useChatAttentionCenter가 통째로 맡는다.
  const openAia = useCallback(() => setAiaOpen(true), []);
  const {
    chatAttention,
    aiaAttentionTarget,
    chatViewAttentionTarget,
    sessionAttentionTarget,
    resetSessionAttentionTarget,
    markAllAttentionRead,
    clearReadAttention,
    dismissAttention,
    openAttentionItem,
    clearSessionAttentionTarget,
    clearAiaAttentionTarget,
    clearChatViewAttentionTarget,
  } = useChatAttentionCenter({
    popoutRequest,
    snapshotRef,
    activateView,
    requestSettingsTab,
    syncSessionCatalog,
    setSelectedSession,
    setError,
    openAia,
  });

  // AIA는 시스템 설정에서 고른 시스템 에이전트로 실행된다. 고르지 않으면 AIA 기능
  // 전체(트리거·팝업·자동 요청·알림)가 꺼진다. 선택값은 백엔드에 영속되므로 새로고침
  // 뒤에도 자동화 스냅샷 폴링으로 그대로 복원된다.
  const aiaProviderId = aiaRuntimeProvider(automation);
  // 자동화 스냅샷은 폴링마다 새 객체로 오므로, 저장된 값이 실제로 달라질 때만 새 실행설정을
  // 만든다. AIA 팝업은 이 값이 바뀌는 것을 보고 돌던 대화를 새 설정으로 다시 시작한다.
  const aiaRuntimeSignature = JSON.stringify(automation?.settings.systemAgentRuntimes ?? null);
  const aiaRuntime = useMemo(
    // 공급자를 고르지 않으면 AIA 팝업 자체를 그리지 않으므로, 자리만 채우는 기본값이다.
    () => aiaRuntimeSettings(automation?.settings.systemAgentRuntimes, aiaProviderId ?? "codex"),
    [aiaProviderId, aiaRuntimeSignature],
  );

  // 즉시 트리거용 스킬 변경 감지. 공통 원본의 내용 지문만 읽는 축약 조회라 짧은
  // 주기로도 부담이 적다. 처음 본 스킬은 기준선만 잡으므로 첫 실행에는 제안이
  // 뜨지 않고, 이후 내용이 바뀐 스킬만 검토 제안 후보가 된다.
  const pollAiaSkillChanges = useCallback(async () => {
    const digests = await getCommonSkillDigests();
    setAiaSkillChanges(aiaSkillChangeStore.saveIfChanged((current) => observeAiaSkillChanges(current, digests, Date.now())));
  }, []);
  usePoll(pollAiaSkillChanges, 30_000, { enabled: !popoutRequest && Boolean(aiaProviderId) });

  // 운영 사건 감지→합치기→제한 분석 호출은 useAiaRuntimeAnalysis가 통째로 맡는다.
  const { analysisSuggestion, dismissAnalysisSuggestion } = useAiaRuntimeAnalysis({
    aiaProviderId,
    aiaOpen,
    popoutRequest,
    snapshot,
    accounts,
    scheduler: schedulerSnapshot,
    automation,
  });

  const aiaSuggestionEvaluation = useMemo(() => {
    if (!snapshot || !aiaSuggestionCatalog) return null;
    return evaluateAiaSuggestionState({
      catalog: aiaSuggestionCatalog,
      manager: snapshot,
      accounts,
      scheduler: schedulerSnapshot,
      automation,
      attention: chatAttention,
      now: aiaSuggestionNow,
      history: aiaSuggestionHistory,
      skillChanges: aiaSkillChanges.changes,
    });
  }, [accounts, aiaSkillChanges, aiaSuggestionCatalog, aiaSuggestionHistory, aiaSuggestionNow, automation, chatAttention, schedulerSnapshot, snapshot]);
  const aiaSuggestions = aiaProviderId && !popoutRequest
    ? [
      ...(analysisSuggestion ? [analysisSuggestion] : []),
      ...(aiaSuggestionEvaluation?.suggestions ?? []),
    ]
    : [];

  // 해결/재발 상태를 반영한 이력만 로컬에 저장한다. 오류 원문, 계정 정보와 대화
  // 본문은 평가 이력에 들어가지 않는다.
  useEffect(() => {
    const next = aiaSuggestionEvaluation?.history;
    if (!next) return;
    setAiaSuggestionHistory(aiaSuggestionHistoryStore.saveIfChanged(() => next));
  }, [aiaSuggestionEvaluation?.history]);

  const dismissSuggestion = useCallback((suggestion: AiaSuggestion) => {
    if (suggestion.source === "isolatedAnalysis") {
      dismissAnalysisSuggestion(suggestion.fingerprint);
      return;
    }
    // 스킬 변경 제안은 감지 목록에서 내린다. 기준선은 남으므로 같은 내용으로는
    // 다시 뜨지 않고, 스킬이 또 바뀌면 새 변경으로 다시 제안된다.
    if (suggestion.kind === "skillContentChanged") {
      setAiaSkillChanges(aiaSkillChangeStore.saveIfChanged((current) => clearAiaSkillChange(current, suggestion.targetId)));
    }
    setAiaSuggestionHistory(aiaSuggestionHistoryStore.saveIfChanged((current) => dismissAiaSuggestion(current, suggestion, Date.now())));
  }, [dismissAnalysisSuggestion]);

  const handleAiaAutoPrompt = useCallback((prompt: AiaAutoPrompt, sent: boolean) => {
    setAiaAutoPrompt((current) => current?.requestId === prompt.requestId ? null : current);
    if (!sent) return;
  }, []);
  // AIA가 꺼져 있으면 열 수 있는 대화가 없으므로 남은 알림도 트리거에 표시하지 않는다.
  const aiaAttention = aiaProviderId ? selectAiaAttention(chatAttention.items) : null;
  // 트리거에 점 세 개만 띄우던 자리를, 마지막 대화를 잘라 담은 말풍선으로 바꾼다.
  // 미리보기를 못 받은 알림(옛 백엔드·본문 없는 턴)은 기존 점 표시로 남는다.
  const suggestionBubble = aiaSuggestions[0]
    ? { request: "AIA 제안", response: aiaSuggestions[0].title }
    : null;
  const aiaBubbleKey = aiaAttention
    ? `attention:${aiaAttention.id}`
    : aiaSuggestions[0]
      ? `suggestion:${aiaSuggestions[0].fingerprint}`
      : null;
  // 화면 조작 중에는 아래에서 한 번 더 걸러 낸다(커서·안내 말풍선과 겹치지 않게).
  const aiaBubbleCandidate = shouldShowAiaAttentionBubble(aiaOpen, aiaBubbleKey, closedAiaBubbleKey)
    ? aiaAttentionBubble(aiaAttention) ?? suggestionBubble
    : null;
  const aiaEmphasized = Boolean(aiaProviderId) && (aiaOpen || aiaBusy || Boolean(aiaAttention) || aiaSuggestions.length > 0);
  const aiaEmphasizedWasRef = useRef(aiaEmphasized);
  // 배회 회전은 애니메이션 값이라 강조가 풀리면 transform이 그대로 스냅된다(트랜지션은 지정값
  // 변화에만 반응). 해제 순간의 각도를 인라인으로 붙잡아 0도까지 천천히 되감는다.
  useEffect(() => {
    const was = aiaEmphasizedWasRef.current;
    aiaEmphasizedWasRef.current = aiaEmphasized;
    const needle = aiaTriggerRef.current?.querySelector<SVGGElement>(".aia-mark-needle");
    if (!needle) return undefined;
    if (aiaEmphasized) {
      // 되감기 도중 다시 강조되면 인라인 고정을 걷어 배회 애니메이션이 이어받게 한다.
      needle.style.removeProperty("animation-name");
      needle.style.removeProperty("transition");
      needle.style.removeProperty("transform");
      return undefined;
    }
    if (!was) return undefined;
    const frozen = getComputedStyle(needle).transform;
    if (!frozen || frozen === "none") return undefined;
    // 단축 속성(animation)은 React가 인라인으로 준 인스턴스별 delay/duration까지 지워 버리므로
    // animation-name만 끈다.
    needle.style.animationName = "none";
    needle.style.transition = "none";
    needle.style.transform = frozen;
    // 고정된 각도가 한 프레임 반영된 뒤에 트랜지션을 걸어야 스냅 없이 되감긴다.
    void needle.getBoundingClientRect();
    needle.style.transition = "transform 1.6s ease-in-out";
    needle.style.transform = "rotate(0deg)";
    const settle = () => {
      needle.style.removeProperty("animation-name");
      needle.style.removeProperty("transition");
      needle.style.removeProperty("transform");
    };
    needle.addEventListener("transitionend", settle, { once: true });
    return () => needle.removeEventListener("transitionend", settle);
  }, [aiaEmphasized]);
  const visibleChatAttention = withoutAiaAttention(chatAttention);
  const toggleAia = useCallback(() => {
    if (aiaAttention) {
      openAttentionItem(aiaAttention);
      return;
    }
    setAiaOpen((current) => !current);
  }, [aiaAttention, openAttentionItem]);

  // 말풍선 클릭은 미확인 상태나 제안을 지우지 않고 현재 미리보기만 닫는다. 실제 AIA
  // attention이 남아 있으므로 사용자는 활성화된 트리거를 눌러 해당 대화를 확인할 수 있다.
  const closeAiaBubble = useCallback(() => {
    if (aiaBubbleKey) setClosedAiaBubbleKey(aiaBubbleKey);
  }, [aiaBubbleKey]);

  // 알림이 오면 팝업 번들을 미리 받아 둔다. 지연 로딩을 기다리는 사이 안 열린 줄 알고
  // 다시 누르는 일을 막는다. open=false로 마운트해도 대화를 시작하지는 않는다.
  useEffect(() => {
    if (aiaAttention) setAiaMounted(true);
  }, [aiaAttention]);

  const selectSession = useCallback((session: SessionSummary | null) => {
    // 세션 팝아웃 창은 이 세션 하나만 보여주므로, 상세를 닫으면 창을 닫는다.
    if (!session && popoutRequest?.kind === "session") {
      void closePopoutWindow();
      return;
    }
    resetSessionAttentionTarget();
    setSelectedSession(session);
  }, [popoutRequest]);

  const openSession = useCallback((session: SessionSummary) => {
    selectSession(session);
    activateView("sessions");
  }, [selectSession, activateView]);

  // 대시보드 '반복 일정' 패널에서 채팅 뷰의 반복 요청 탭으로 바로 이동한다.
  const openSchedules = useCallback(() => {
    requestChatTab("schedules");
    activateView("chat");
  }, [activateView, requestChatTab]);

  // AIA 화면 조작(안내·요소 조회·커서 클릭)은 훅 하나가 통째로 맡는다. App 본문에는
  // 화면 전환과 탭 요청만 남기고, 안내 포인터·커서 상태와 대기 순서는 훅 안에서 끝낸다.
  const requestGuideTab = useCallback((guideView: ViewId, tab: string) => {
    if (guideView === "settings") requestSettingsTab(tab as SettingsTabId);
    if (guideView === "chat") requestChatTab(tab as ChatTab);
    if (guideView === "workflows") requestWorkflowsTab(tab as WorkflowsTabId);
    if (guideView === "addons") requestAddonsTab(tab as AddonsTabId);
  }, [requestAddonsTab, requestChatTab, requestSettingsTab, requestWorkflowsTab]);
  const {
    uiGuide,
    uiCursor,
    aiaGuideYield,
    dismissUiGuide,
    showUiGuide,
    answerAiaUiQuery,
    performAiaUiClick,
  } = useAiaScreenControl({ view, activateView, requestGuideTab, aiaTriggerRef, setAiaOpen, popoutRequest });

  // AIA가 화면을 조작하는 동안에는 커서와 안내 말풍선이 이미 같은 이야기를 하고 있다.
  // 트리거 말풍선까지 겹쳐 띄우면 시선이 갈라지므로 조작이 끝날 때까지 접어 둔다.
  // (미확인 표시인 점 세 개는 그대로 남아 확인할 대화가 있다는 사실은 잃지 않는다.)
  const aiaBubble = uiCursor || uiGuide ? null : aiaBubbleCandidate;
  // 설정 화면의 자동 요청이 AIA를 다시 열어도 전용 창의 안내가 끝날 때까지 가리지 않는다.
  const aiaVisible = aiaOpen && !(popoutRequest?.kind === "aia" && uiGuide);

  const connectCli = useCallback((provider: ProviderStatus) => {
    setSetupProviderId(provider.provider);
  }, []);

  const applyAutomationChange = useCallback((next: SystemAutomationSnapshot) => {
    automationRef.current = next;
    setAutomation(next);
    setLocale(next.settings.language.code, next.uiMessages);
  }, [setLocale]);

  const updateSessionMeta = useCallback((source: ProviderId, id: string, meta: SessionMeta) => {
    setSnapshot((current) => {
      if (!current) return current;
      const update = (session: SessionSummary): SessionSummary => {
        if (session.source !== source || session.id !== id) return session;
        const title = meta.customTitle ?? session.sourceTitle ?? `(제목 없음) ${session.id.slice(0, 8)}`;
        return { ...session, title, meta };
      };
      const sessions = current.sessions.map(update);
      const recent = current.dashboard.recent.map(update).filter((session) => !session.meta.hidden);
      const folders = recountSessionFolders(current.folders, sessions);
      return { ...current, sessions, folders, dashboard: { ...current.dashboard, recent } };
    });
    setSelectedSession((current) => current && current.source === source && current.id === id ? { ...current, title: meta.customTitle ?? current.sourceTitle ?? current.title, meta } : current);
  }, []);

  // 폴더 삭제는 하위 트리까지 함께 지우므로 배정 정리도 지워진 ID 전체를 기준으로 한다.
  const updateFolders = useCallback((folders: SessionFolder[], deletedFolderIds?: string[]) => {
    const deleted = deletedFolderIds && deletedFolderIds.length > 0 ? new Set(deletedFolderIds) : null;
    setSnapshot((current) => {
      if (!current) return current;
      const sessions = deleted
        ? current.sessions.map((session) => ({
            ...session,
            meta: {
              ...session.meta,
              folderIds: session.meta.folderIds.filter((id) => !deleted.has(id)),
            },
          }))
        : current.sessions;
      return { ...current, sessions, folders: recountSessionFolders(folders, sessions) };
    });
    if (deleted) {
      setSelectedSession((current) => current ? {
        ...current,
        meta: {
          ...current.meta,
          folderIds: current.meta.folderIds.filter((id) => !deleted.has(id)),
        },
      } : current);
    }
  }, []);

  if (!snapshot && !error) {
    return (
      <main className="launch-screen">
        <LogoMark size={64} />
        <h1>Agent Manager</h1>
        <LoadingState label={reconnecting
          ? text("서버와 다시 연결하는 중…", "Reconnecting to the server…")
          : text("로컬 에이전트 데이터를 인덱싱하고 있습니다", "Indexing local agent data")} />
      </main>
    );
  }

  if (!snapshot) {
    return (
      <main className="launch-screen">
        <LogoMark size={64} />
        <h1>Agent Manager</h1>
        <ErrorBanner message={error ?? text("앱을 시작하지 못했습니다", "Could not start the app")} />
        <button className="button primary" type="button" onClick={() => refresh(true)}>{text("다시 시도", "Retry")}</button>
      </main>
    );
  }

  const title = navigationTitle(view, locale, text);
  const setupProvider = setupProviderId
    ? snapshot.status.providers.find((provider) => provider.provider === setupProviderId) ?? null
    : null;
  const aiaProvider = aiaProviderId
    ? snapshot.status.providers.find((provider) => provider.provider === aiaProviderId) ?? null
    : null;
  const skillTransferAiaAvailable = Boolean(aiaProviderId && aiaProvider?.cli.detected);
  const sidebarUsage = sidebarUsageSources(accounts, antigravityDetected ? antigravityUsage : null);
  const visibleNavigation = [
    ...navigationPreferences.order
      .filter((id) => !navigationPreferences.hidden.includes(id))
      .map((id) => ({ id, icon: NAVIGATION[id].icon })),
    { id: "settings" as const, icon: NAVIGATION.settings.icon },
  ];

  return (
    <div className={`manager-shell${aiaVisible && aiaProviderId ? " aia-open" : ""}${popoutRequest ? " popout" : ""}${popoutRequest?.kind === "aia" ? " aia-popout" : ""}`}>
      <aside className="app-sidebar">
        <div className="brand">
          <button
            className="brand-logo"
            type="button"
            disabled={appRefreshing}
            aria-label={text("데이터 새로고침", "Refresh data")}
            title={text("데이터 새로고침", "Refresh data")}
            onClick={() => { void refreshApp(); }}
          ><LogoMark size={37} spinning={appRefreshing} /></button>
          <div><strong>Agent Manager</strong><span>LOCAL CONTROL PLANE</span></div>
        </div>
        <nav aria-label={text("주 메뉴", "Main menu")}>
          {visibleNavigation.map((item) => (
            <button className={view === item.id ? "active" : ""} aria-current={view === item.id ? "page" : undefined} type="button" key={item.id} data-ui-anchor={`nav.${item.id}`} onClick={() => activateView(item.id)}>
              <span><item.icon size={16} strokeWidth={1.8} aria-hidden="true" /></span>{navigationLabel(item.id, locale, text)}
              {item.id === "sessions" && <em>{snapshot.dashboard.sessionCount}</em>}
              {previewView(item.id) && <em className="nav-preview-tag" data-ui-anchor={`nav.${item.id}.preview`}>{text("준비중", "Preparing")}</em>}
            </button>
          ))}
        </nav>
      </aside>

      <section className="app-content">
        <header className="topbar">
          <h1>{title}<HelpHint
            label={locale === "ko" ? `${title} 메뉴 설명` : `${title} menu details`}
            title={locale === "ko" ? `${title} 메뉴` : `${title} menu`}
            popoverClassName={view === "skills" || view === "instructions" ? "skill-menu-help-popover" : undefined}
          >{navigationHelpDescription(view, text)}</HelpHint></h1>
          <div className="topbar-actions">
            <span className="aia-trigger-shell">
              <button
                ref={aiaTriggerRef}
                data-ui-anchor="topbar.aia"
                className={`aia-trigger${aiaVisible && aiaProviderId ? " active" : ""}${aiaBusy && aiaProviderId ? " busy" : ""}${aiaAttention ? " unread" : ""}${aiaAttention || aiaSuggestions.length > 0 ? " attention" : ""}`}
                type="button"
                aria-label={!aiaProviderId ? text(AIA_DISABLED_HINT_KO, AIA_DISABLED_HINT_EN) : aiaAttention || aiaSuggestions.length > 0 ? text("AIA에 확인할 내용이 있습니다", "AIA has something for you to check") : aiaBusy ? text("AIA가 작업 중입니다", "AIA is working") : text("AIA 열기", "Open AIA")}
                aria-pressed={aiaVisible && Boolean(aiaProviderId)}
                onClick={() => { if (aiaProviderId) toggleAia(); else openSystemAgentSettings(); }}
                title={!aiaProviderId
                  ? text(AIA_DISABLED_HINT_KO, AIA_DISABLED_HINT_EN)
                  : aiaAttention?.kind === "approval" ? text("AIA 권한 승인이 필요합니다", "AIA needs permission approval") : aiaAttention ? text("AIA 답변을 확인하세요", "Check AIA's reply") : aiaSuggestions.length > 0 ? text("AIA 제안을 확인하세요", "Check AIA's suggestions") : aiaBusy ? text("AIA가 작업 중입니다", "AIA is working") : text("AIA 열기", "Open AIA")}
              ><span className="aia-mark-shell" aria-hidden="true"><AiaMark size={18} /></span><span className="aia-trigger-name">AIA</span>{aiaAttention && !aiaBubble && !aiaOpen && <span className="aia-attention-label" aria-hidden="true">...</span>}</button>
              {aiaBubble && <button
                className={`aia-attention-bubble${aiaAttention?.kind === "approval" ? " approval" : ""}`}
                type="button"
                aria-label={text("AIA 메시지 미리보기 닫기", "Close AIA message preview")}
                title={text("AIA 메시지 미리보기 닫기", "Close AIA message preview")}
                onClick={closeAiaBubble}
              >
                {aiaBubble.request && <span className="aia-attention-bubble-request">{aiaBubble.request}</span>}
                <span className="aia-attention-bubble-answer">
                  <span className="aia-attention-bubble-avatar" aria-hidden="true"><AiaMark size={14} /></span>
                  <span className="aia-attention-bubble-response"><span>{aiaBubble.response}</span></span>
                </span>
              </button>}
            </span>
            <ChatAttentionCenter snapshot={visibleChatAttention} sessions={snapshot.sessions} onOpen={openAttentionItem} onMarkAllRead={markAllAttentionRead} onClearRead={clearReadAttention} onDismiss={dismissAttention} />
          </div>
        </header>
        {reconnecting && <div className="content-error">
          <div className="reconnect-banner" role="status">
            <span className="spinner" aria-hidden="true" />
            {text("서버 연결이 끊겼습니다. 재연결하는 중…", "Connection lost. Reconnecting…")}
          </div>
        </div>}
        {error && <div className="content-error">
          <ErrorBanner message={error} />
          {view === "sessions" && <button className="button secondary" type="button" onClick={() => { void reconcileSessionList(); }}>{text("목록 갱신 재시도", "Retry list refresh")}</button>}
        </div>}
        <main className="view-content">
          <Suspense fallback={<LoadingState label={text("화면을 불러오는 중…", "Loading view…")} />}>
          <ViewPanel id="dashboard" activeView={view} mounted={mountedViews}>{() => <MemoDashboardView snapshot={snapshot} scheduler={schedulerSnapshot} attention={visibleChatAttention} accounts={accounts} onOpenSession={openSession} onOpenSchedules={openSchedules} onConnectCli={connectCli} />}</ViewPanel>
          <ViewPanel id="chat" activeView={view} mounted={mountedViews}>{() => <MemoChatView providers={snapshot.status.providers} accounts={accounts} projects={projectOptions} models={modelOptions} sessions={snapshot.sessions} messageDisplayMode={messageDisplayMode} transcriptLimit={transcriptLimit} onTranscriptLimitChange={setTranscriptLimit} scheduler={schedulerSnapshot} onRefreshScheduler={refreshScheduler} onSchedulerSnapshot={applySchedulerSnapshot} tabRequest={chatTabRequest} onConnectCli={connectCli} onOpenSession={openSession} onSessionCatalogChanged={syncSessionCatalog} attentionTarget={chatViewAttentionTarget} onAttentionTargetHandled={clearChatViewAttentionTarget} popout={Boolean(popoutRequest)} />}</ViewPanel>
          <ViewPanel id="sessions" activeView={view} mounted={mountedViews}>{() => <MemoSessionsView providers={snapshot.status.providers} sessions={snapshot.sessions} folders={snapshot.folders} catalogHealth={catalogHealth} onRefreshList={reconcileSessionList} selected={selectedSession} messageDisplayMode={messageDisplayMode} transcriptLimit={transcriptLimit} onTranscriptLimitChange={setTranscriptLimit} onSelect={selectSession} onMetaChanged={updateSessionMeta} onFoldersChanged={updateFolders} onSessionCatalogChanged={syncSessionCatalog} attentionTarget={sessionAttentionTarget} onAttentionTargetHandled={clearSessionAttentionTarget} popout={Boolean(popoutRequest)} />}</ViewPanel>
          <ViewPanel id="docs" activeView={view} mounted={mountedViews}>{() => <MemoDocsView providers={snapshot.status.providers} accounts={accounts} models={modelOptions} onRequestAiaPrompt={requestAiaPrompt} />}</ViewPanel>
          <ViewPanel id="instructions" activeView={view} mounted={mountedViews}>{() => <MemoInstructionsView onChanged={() => { setResourceRepositoryRevision((current) => current + 1); void refresh(); void pollAiaSuggestionCatalog(); }} onRequestAiaPrompt={requestAiaPrompt} repositoryRevision={resourceRepositoryRevision} automation={automation} onAutomationChange={applyAutomationChange} />}</ViewPanel>
          <ViewPanel id="skills" activeView={view} mounted={mountedViews}>{() => <MemoSkillsView skills={snapshot.skills} automation={automation} onAutomationChange={applyAutomationChange} onSkillsChanged={() => { void refresh(); void pollAiaSuggestionCatalog(); }} onRequestAiaPrompt={requestAiaPrompt} aiaTransferAvailable={skillTransferAiaAvailable} catalogHealth={catalogHealth} repositoryRevision={resourceRepositoryRevision} />}</ViewPanel>
          <ViewPanel id="agents" activeView={view} mounted={mountedViews}>{() => <MemoAgentsView agents={snapshot.agents} automation={automation} onAutomationChange={applyAutomationChange} />}</ViewPanel>
          <ViewPanel id="artifacts" activeView={view} mounted={mountedViews}>{() => <MemoArtifactsView groups={snapshot.artifacts} automation={automation} onAutomationChange={applyAutomationChange} />}</ViewPanel>
          <ViewPanel id="workflows" activeView={view} mounted={mountedViews}>{() => <MemoWorkflowsView active={view === "workflows"} onRequestAiaPrompt={requestAiaPrompt} tabRequest={workflowsTabRequest} />}</ViewPanel>
          <ViewPanel id="addons" activeView={view} mounted={mountedViews}>{() => <MemoAddonsView active={view === "addons"} tabRequest={addonsTabRequest} />}</ViewPanel>
          <ViewPanel id="storage" activeView={view} mounted={mountedViews}>{() => <MemoStorageView />}</ViewPanel>
          <ViewPanel id="settings" activeView={view} mounted={mountedViews}>{() => <MemoSettingsView active={view === "settings"} providers={snapshot.status.providers} accounts={accounts} models={modelOptions} onAccountsChange={setAccounts} onConnectCli={connectCli} themeMode={themeMode} onThemeModeChange={setThemeMode} accentColor={accentColor} onAccentColorChange={setAccentColor} navigationPreferences={navigationPreferences} onNavigationPreferencesChange={setNavigationPreferences} messageDisplayMode={messageDisplayMode} onMessageDisplayModeChange={setMessageDisplayMode} automation={automation} onAutomationChange={applyAutomationChange} onRequestAiaPrompt={requestAiaPrompt} tabRequest={settingsTabRequest} systemAgentNoticeRequest={systemAgentNoticeRequest} onRepositoryChanged={invalidateResourceViews} />}</ViewPanel>
          </Suspense>
        </main>
      </section>
      <AppStatusbar
        sources={sidebarUsage}
        providers={snapshot.status.providers}
        platform={snapshot.status.platform}
        architecture={snapshot.status.architecture}
        density={sidebarUsageDensity}
        onDensityChange={setSidebarUsageDensity}
        refreshing={statusRefreshing}
        onRefresh={() => { void refreshStatusCard(); }}
      />
      {showNewProjectsModal && <NewProjectsModal
        projects={pendingProjects}
        busyPath={pendingProjectBusy}
        onDecide={(entry, active) => { void decidePendingProject(entry, active); }}
        onKeepAll={() => { void keepAllPendingProjects(); }}
        onLater={deferPendingProjects}
      />}
      {setupProvider && <ErrorBoundary label="CLI 연결" scope="view"><Suspense fallback={null}><CliConnectionDrawer
        provider={setupProvider}
        onClose={() => setSetupProviderId(null)}
        onRefresh={async () => { await refresh(true); }}
        onOpenChat={() => { setSetupProviderId(null); activateView("chat"); }}
      /></Suspense></ErrorBoundary>}
      {aiaMounted && aiaProviderId && <ErrorBoundary label="AIA 대화" scope="view"><Suspense fallback={null}><AiaChatPopup
        open={aiaVisible}
        windowId={popoutRequest?.kind === "aia" ? popoutRequest.windowId : null}
        provider={aiaProviderId}
        runtime={aiaRuntime}
        providerName={aiaProvider?.displayName ?? aiaProviderId}
        providerConnected={Boolean(aiaProvider?.cli.detected)}
        attentionTarget={aiaAttentionTarget}
        autoPrompt={aiaAutoPrompt}
        suggestions={aiaSuggestions}
        onClose={() => { if (popoutRequest?.kind === "aia") void closePopoutWindow(); else setAiaOpen(false); }}
        onAttentionTargetHandled={clearAiaAttentionTarget}
        onAutoPromptHandled={handleAiaAutoPrompt}
        onDismissSuggestion={dismissSuggestion}
        onBusyChange={setAiaBusy}
        onUiGuide={showUiGuide}
        onUiQuery={answerAiaUiQuery}
        onUiClick={performAiaUiClick}
        yieldForGuide={aiaGuideYield}
        onConnectProvider={() => {
          setAiaOpen(false);
          if (aiaProvider) setSetupProviderId(aiaProvider.provider);
        }}
      /></Suspense></ErrorBoundary>}
      {uiGuide && <UiGuidePointer key={uiGuide.requestId} anchor={uiGuide.element} note={uiGuide.note} label={uiGuide.label} onDismiss={dismissUiGuide} />}
      {uiCursor && <UiCursor state={uiCursor} />}
    </div>
  );
}

interface UiGuideState {
  requestId: number;
  view: ViewId | null;
  label: string;
  note: string | null;
  element: Element;
}

const nextFrame = () => new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
const waitMs = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

/**
 * 백엔드는 화면 응답을 3초만 기다린다. 그 뒤 도착한 답은 받는 곳이 없으므로 실패로
 * 올리지 않고 버린다. 조회도 클릭도 같은 계약이라 응답 경로를 한 벌로 둔다.
 */
async function answerUiQueryQuietly(queryId: string, answer: unknown) {
  try {
    await answerUiQuery(queryId, answer);
  } catch {
    // 백엔드가 이미 기다림을 끝냈다. 다음 조회에서 다시 답한다.
  }
}

/** 커서가 처음 나타나는 자리. AIA 트리거에서 출발해야 누가 누르는지 보인다. */
function cursorHomePosition(trigger: HTMLButtonElement | null): UiCursorState {
  const origin = trigger?.getBoundingClientRect();
  return origin
    ? { x: origin.left + origin.width / 2, y: origin.top + origin.height / 2, pressing: false }
    : { x: window.innerWidth / 2, y: window.innerHeight / 2, pressing: false };
}

/**
 * AIA가 화면을 직접 다루는 세 경로(show_ui_guide·find_ui_elements·click_ui_element)와
 * 그 결과로 뜨는 안내 포인터·커서 상태를 한곳에 모은다. App은 화면 전환(`activateView`)과
 * 탭 요청(`requestGuideTab`)만 넘기고, 어떤 순서로 열고 얼마나 기다릴지는 여기서 정한다.
 */
/**
 * 알림창(attention) 한 벌 — 목록 폴링, 낙관적 읽음·삭제, 알림 클릭의 화면 라우팅,
 * 세션·AIA·채팅 뷰로 내려보내는 타깃과 그 해제까지를 훅 하나가 통째로 맡는다.
 * App 본문에는 이 훅이 돌려주는 값을 화면에 꽂는 일만 남는다.
 */
function useChatAttentionCenter({ popoutRequest, snapshotRef, activateView, requestSettingsTab, syncSessionCatalog, setSelectedSession, setError, openAia }: {
  popoutRequest: PopoutRequest | null;
  snapshotRef: MutableRefObject<ManagerSnapshot | null>;
  activateView: (view: ViewId) => void;
  requestSettingsTab: (tab: SettingsTabId) => void;
  syncSessionCatalog: (source: ProviderId, id: string) => Promise<void>;
  setSelectedSession: Dispatch<SetStateAction<SessionSummary | null>>;
  setError: (message: string | null) => void;
  openAia: () => void;
}) {
  const [chatAttention, setChatAttention] = useState<ChatAttentionSnapshot>(EMPTY_CHAT_ATTENTION);
  const [aiaAttentionTarget, setAiaAttentionTarget] = useState<AiaAttentionTarget | null>(null);
  // 채팅 팝아웃 창은 기존 attention 경로를 재사용해 대상 채팅에 바로 연결한다.
  // requestId 0은 attention 요청(1부터 증가)과 겹치지 않는다.
  const [chatViewAttentionTarget, setChatViewAttentionTarget] = useState<ChatViewAttentionTarget | null>(() =>
    popoutRequest?.kind === "chat"
      ? { chatId: popoutRequest.chatId, attentionId: "", markRead: false, requestId: 0 }
      : null);
  const [sessionAttentionTarget, setSessionAttentionTarget] = useState<SessionAttentionTarget | null>(null);

  const attentionRequestId = useRef(0);
  // 알림 조작은 화면을 먼저 바꾸고 요청을 뒤로 보낸다. 이 세대 번호와 진행 수는 그 사이
  // 떠 있던 폴링 응답이나 앞선 요청의 응답이 뒤늦게 도착해 방금 바꾼 목록을 되돌리는 것을
  // 막는다. 요청이 실패하면 되돌리지 않고 폴링이 서버 상태로 맞추게 둔다.
  const attentionRevision = useRef(0);
  const attentionPending = useRef(0);
  const handledAttentionRequests = useRef(new Set<number>());

  const pollAttention = useCallback(async () => {
    try {
      const revision = attentionRevision.current;
      const next = await getChatAttentionSnapshot();
      // 이 응답을 기다리는 사이 사용자가 읽음·삭제를 눌렀으면, 서버가 그 요청을 반영하기
      // 전에 뜬 목록이다. 그대로 올리면 방금 사라진 알림이 되살아나 깜빡인다. 버리고
      // 다음 폴링을 기다린다.
      if (attentionPending.current > 0 || attentionRevision.current !== revision) return;
      setChatAttention(keepIfSame(next));
      // AIA는 일반 인앱 알림창에서만 분리한다. 기기 알림은 모든 프로필을 알려야 한다.
      // 중복 알림을 막기 위해 팝아웃 창은 표출하지 않는다(본 창이 대표로 보낸다).
      if (!popoutRequest) void notifyNewAttention(next.items, snapshotRef.current?.sessions ?? []);
    } catch (cause) {
      // 현재 알림 목록은 유지한 채, 폴링 루프만 백오프한다.
      throw cause;
    }
  }, [popoutRequest]);
  usePoll(pollAttention, 2_000);

  const applyAttentionMutation = useCallback((
    optimistic: (current: ChatAttentionSnapshot) => ChatAttentionSnapshot,
    request: () => Promise<ChatAttentionSnapshot>,
  ) => {
    attentionRevision.current += 1;
    attentionPending.current += 1;
    const revision = attentionRevision.current;
    setChatAttention(optimistic);
    return request()
      .then((next) => {
        // 뒤이어 다른 조작이 끼어들었으면 그쪽 결과가 더 새롭다. 이 응답은 버린다.
        if (attentionRevision.current === revision) setChatAttention(next);
        return true;
      })
      .catch(() => false)
      .finally(() => { attentionPending.current -= 1; });
  }, []);

  const markAttentionRead = useCallback((id: string) => applyAttentionMutation(
    (current) => markAttentionReadLocally(current, id),
    () => markChatAttentionRead(id),
  ), [applyAttentionMutation]);

  const markAllAttentionRead = useCallback(() => {
    // AIA 알림은 인앱 알림창 목록에서 빠져 AIA 패널이 따로 관리한다. 화면에 없는 알림을
    // 읽음 처리하지 않도록 제외 프로필을 서버에도 그대로 넘긴다.
    void applyAttentionMutation(
      (current) => markAllAttentionReadLocally(current, ["aia"]),
      () => markAllChatAttentionRead(["aia"]),
    );
  }, [applyAttentionMutation]);

  const clearReadAttention = useCallback(() => {
    void applyAttentionMutation(clearReadAttentionLocally, clearReadChatAttention);
  }, [applyAttentionMutation]);

  // 묶어서 보여 준 알림은 머리줄 하나를 밀어 통째로 지운다. 서버에는 낱개 삭제밖에
  // 없으므로 차례로 보내고, 화면은 첫 요청 전에 이미 전부 빠진 상태를 그린다.
  const dismissAttention = useCallback((items: ChatAttentionItem[]) => applyAttentionMutation(
    (current) => items.reduce((snapshot, item) => dismissAttentionLocally(snapshot, item.id), current),
    async () => {
      let latest = await dismissChatAttention(items[0].id);
      for (const item of items.slice(1)) latest = await dismissChatAttention(item.id);
      return latest;
    },
  ), [applyAttentionMutation]);

  const openAttentionItem = useCallback((item: ChatAttentionItem) => {
    if (item.kind === "accountSwitch") {
      // 계정 전환은 채팅이 없다. 전환 이력이 있는 설정의 연결 탭으로 열고 읽음 처리한다.
      void markAttentionRead(item.id);
      requestSettingsTab("connections");
      activateView("settings");
      return;
    }
    if (item.profile === "aia") {
      attentionRequestId.current += 1;
      setAiaAttentionTarget({
        chatId: item.chatId,
        attentionId: item.id,
        markRead: item.kind !== "approval",
        requestId: attentionRequestId.current,
      });
      openAia();
      return;
    }
    const openAttachedChat = (chatId: string) => {
      attentionRequestId.current += 1;
      setChatViewAttentionTarget({
        chatId,
        attentionId: item.id,
        markRead: item.kind !== "approval",
        requestId: attentionRequestId.current,
      });
      activateView("chat");
    };
    const findIndexedSession = (sessionId: string) => snapshotRef.current?.sessions
      .find((candidate) => candidate.source === item.source && candidate.id === sessionId) ?? null;
    const sessionId = item.providerSessionId;
    if (!sessionId) {
      // 공급자 세션 기록이 없으면 색인될 수 없다. 예약 실행이어도 세션 화면 대신
      // 붙어 있는 채팅으로 연다. 세션 화면에서 반영을 기다리면 영구히 실패한다.
      openAttachedChat(item.chatId);
      return;
    }
    if (item.unattended) {
      const indexed = findIndexedSession(sessionId);
      // 색인을 기다린 뒤에 화면을 옮기면 클릭하고도 몇 초 동안 아무 일이 없는 것처럼 보인다.
      // 목적지는 어차피 세션 화면이므로 먼저 옮기고, 대상은 색인이 끝나는 대로 고른다.
      setSessionAttentionTarget(null);
      let selectionAtClick: SessionSummary | null = null;
      setSelectedSession((current) => {
        selectionAtClick = current;
        // 대상을 아직 못 찾았어도 보던 세션 선택을 지우지는 않는다.
        return indexed ?? current;
      });
      setError(null);
      activateView("sessions");
      void (async () => {
        let session = indexed;
        if (!session) {
          await syncSessionCatalog(item.source, sessionId);
          session = findIndexedSession(sessionId);
          // 기다리는 동안 사용자가 선택을 바꿨으면 그 선택을 빼앗지 않는다.
          if (session) {
            const found = session;
            setSelectedSession((current) => adoptFoundSession(current, selectionAtClick, found));
          }
        }
        if (!session) {
          setError("예약 실행 세션이 아직 세션 목록에 반영되지 않았습니다.");
          return;
        }
        if (item.kind !== "approval") await markAttentionRead(item.id);
      })().catch((cause: unknown) => {
        setError(errorText(cause));
      });
      return;
    }
    // 공급자 세션이 이미 카탈로그에 있으면 런타임이 처음 시작된 화면(resuming 여부)이
    // 아니라 세션을 기준으로 연다. 알림 생성 뒤 같은 세션이 새 chatId로 이어져도
    // 종료된 옛 채팅 화면으로 이동하지 않고 세션 상세가 현재 실행을 다시 해석한다.
    void (async () => {
      const route = await resolveAttentionRoute(item, {
        findIndexedSession,
        syncSessionCatalog: () => syncSessionCatalog(item.source, sessionId),
        findActiveChatId: async () =>
          (await getDetachedChatForSession(item.source, sessionId))?.chatId ?? null,
      });
      if (route.kind === "chat") {
        openAttachedChat(route.chatId);
        return;
      }
      if (route.kind === "ended") {
        setError("알림의 실행이 이미 종료되었고 세션이 아직 세션 목록에 반영되지 않았습니다. 잠시 후 세션 화면에서 다시 확인하세요.");
        return;
      }
      setSelectedSession(route.session);
      attentionRequestId.current += 1;
      setSessionAttentionTarget({
        chatId: item.chatId,
        attentionId: item.id,
        markRead: item.kind !== "approval",
        source: item.source,
        sessionId,
        requestId: attentionRequestId.current,
      });
      activateView("sessions");
    })().catch((cause: unknown) => {
      setError(errorText(cause));
    });
  }, [activateView, markAttentionRead, requestSettingsTab, syncSessionCatalog]);

  // 세션·AIA·채팅 뷰 세 곳의 알림 타깃 해제는 같은 절차다. 같은 요청을 두 번 처리하지
  // 않도록 requestId를 기록하고, 그사이 새 타깃이 들어왔으면 지우지 않으며, 실제로 열렸을
  // 때만 읽음 처리한다.
  const clearAttentionTarget = useCallback(<T extends AttentionTarget>(
    setTarget: Dispatch<SetStateAction<T | null>>,
    target: T,
    opened: boolean,
  ) => {
    if (handledAttentionRequests.current.has(target.requestId)) return;
    handledAttentionRequests.current.add(target.requestId);
    setTarget((current) => current?.requestId === target.requestId ? null : current);
    if (opened && target.markRead) void markAttentionRead(target.attentionId);
  }, [markAttentionRead]);

  const clearSessionAttentionTarget = useCallback(
    (target: SessionAttentionTarget, opened: boolean) => clearAttentionTarget(setSessionAttentionTarget, target, opened),
    [clearAttentionTarget],
  );

  const clearAiaAttentionTarget = useCallback(
    (target: AiaAttentionTarget, opened: boolean) => clearAttentionTarget(setAiaAttentionTarget, target, opened),
    [clearAttentionTarget],
  );

  const clearChatViewAttentionTarget = useCallback(
    (target: ChatViewAttentionTarget, opened: boolean) => clearAttentionTarget(setChatViewAttentionTarget, target, opened),
    [clearAttentionTarget],
  );


  const resetSessionAttentionTarget = useCallback(() => setSessionAttentionTarget(null), []);

  return {
    chatAttention,
    aiaAttentionTarget,
    chatViewAttentionTarget,
    sessionAttentionTarget,
    resetSessionAttentionTarget,
    markAllAttentionRead,
    clearReadAttention,
    dismissAttention,
    openAttentionItem,
    clearSessionAttentionTarget,
    clearAiaAttentionTarget,
    clearChatViewAttentionTarget,
  };
}
/**
 * 운영 사건(계정 인증 오류·CLI 유실·일정 실패·번역 실패)을 기준선 대조로 감지하고,
 * 30초 동안 합쳐 가장 중요한 한 건만 제한된 Core 분석 경로로 보낸 뒤 그 결과를 제안
 * 하나로 돌려준다. 사건 예산과 진행 중 표시는 이 훅 안에서만 쓰이므로 App 본문에는
 * 제안과 내림 함수만 남는다.
 */
function useAiaRuntimeAnalysis({ aiaProviderId, aiaOpen, popoutRequest, snapshot, accounts, scheduler, automation }: {
  aiaProviderId: ProviderId | null;
  aiaOpen: boolean;
  popoutRequest: PopoutRequest | null;
  snapshot: ManagerSnapshot | null;
  accounts: AccountSnapshot | null;
  scheduler: SchedulerSnapshot | null;
  automation: SystemAutomationSnapshot | null;
}): { analysisSuggestion: AiaSuggestion | null; dismissAnalysisSuggestion: (fingerprint: string) => void } {
  const [pendingAiaEvents, setPendingAiaEvents] = useState<AiaEvent[]>([]);
  const [aiaAnalysisSuggestion, setAiaAnalysisSuggestion] = useState<{ event: AiaEvent; suggestion: AiaSuggestion } | null>(null);
  const aiaEventBaselineRef = useRef<AiaEventBaseline | null>(null);
  const aiaEventBudgetRef = useRef(aiaEventBudgetStore.load());
  const aiaAnalysisRunningRef = useRef(false);

  // 모든 스냅샷이 처음 모인 시점은 기준선으로만 기록한다. 이후 새로 발생한 운영
  // 전환만 모아 제한된 AIA 분석 후보로 만든다.
  useEffect(() => {
    if (!hasTauriRuntime() || popoutRequest || !snapshot || !accounts || !scheduler || !automation) return;
    const facts = { manager: snapshot, accounts, scheduler: scheduler, automation };
    const previous = aiaEventBaselineRef.current;
    if (!previous) {
      aiaEventBaselineRef.current = captureAiaEventBaseline(facts);
      return;
    }
    const detected = detectAiaEvents(previous, { ...facts, now: Date.now() });
    aiaEventBaselineRef.current = detected.baseline;
    setAiaAnalysisSuggestion((current) => (
      current && aiaEventStillActive(current.event, detected.baseline) ? current : null
    ));
    setPendingAiaEvents((current) => {
      const active = current.filter((event) => aiaEventStillActive(event, detected.baseline));
      const known = new Set(active.map((event) => event.id));
      return [...active, ...detected.events.filter((event) => !known.has(event.id))];
    });
  }, [accounts, automation, popoutRequest, scheduler, snapshot]);

  // 사건은 30초 동안 합치고 가장 중요한 한 건만 전용 Core 경로로 전달한다. 이 경로는
  // 기존 AIA 대화와 분리되며 세션·MCP·도구 없이 1KB 입력과 제한된 JSON 응답만 허용한다.
  useEffect(() => {
    if (pendingAiaEvents.length === 0) return undefined;
    const oldest = Math.min(...pendingAiaEvents.map((event) => event.observedAt));
    const waitMs = Math.max(0, 30_000 - (Date.now() - oldest));
    const timer = window.setTimeout(() => {
      if (!aiaProviderId || aiaOpen || aiaAnalysisRunningRef.current || !hasTauriRuntime() || popoutRequest) return;
      const now = Date.now();
      const event = coalesceAiaEvents(pendingAiaEvents, now);
      if (!event) return;
      setPendingAiaEvents([]);
      if (!canDispatchAiaEvent(aiaEventBudgetRef.current, now)) return;
      const nextBudget = recordAiaEventDispatch(aiaEventBudgetRef.current, now);
      aiaEventBudgetRef.current = nextBudget;
      aiaEventBudgetStore.save(nextBudget);
      aiaAnalysisRunningRef.current = true;
      const eventSummary = `${event.kind}: ${event.summary}${event.coalescedCount && event.coalescedCount > 1 ? ` (병합 사건 ${event.coalescedCount}건)` : ""}`;
      void analyzeAiaEvent(eventSummary)
        .then((analysis) => {
          const fingerprint = suggestionFingerprint("aia-runtime-analysis", event.kind, event.targetId, event.id);
          setAiaAnalysisSuggestion({
            event,
            suggestion: {
              id: fingerprint,
              definitionId: event.kind,
              fingerprint,
              kind: event.kind === "translationFailed" ? "translationFailed" : event.kind === "accountAuthError" ? "accountAuthError" : event.kind === "cliLost" ? "providerCliMissing" : "scheduleRunFailed",
              severity: "error",
              priority: 1_000,
              title: "새 운영 오류를 분석했습니다",
              detail: analysis.summary,
              prompt: analysis.command ?? `현재 발생한 ${event.summary} 원인을 확인하고 안전한 해결 절차를 제안해줘`,
              packId: "aia-runtime-analysis",
              packDisplayName: "AIA 제한 분석",
              source: "isolatedAnalysis",
              skillKey: null,
              targetId: event.targetId,
              stateKey: event.id,
              metadata: { afterResolved: true, cooldownMinutes: 0 },
            },
          });
        })
        .catch(() => undefined)
        .finally(() => { aiaAnalysisRunningRef.current = false; });
    }, waitMs || 1);
    return () => window.clearTimeout(timer);
  }, [aiaOpen, aiaProviderId, pendingAiaEvents, popoutRequest]);

  // 내려도 기준선은 남으므로 같은 사건이 계속 살아 있는 동안에는 다시 제안되지 않는다.
  const dismissAnalysisSuggestion = useCallback((fingerprint: string) => {
    setAiaAnalysisSuggestion((current) => current?.suggestion.fingerprint === fingerprint ? null : current);
  }, []);

  return { analysisSuggestion: aiaAnalysisSuggestion?.suggestion ?? null, dismissAnalysisSuggestion };
}

function useAiaScreenControl({ view, activateView, requestGuideTab, aiaTriggerRef, setAiaOpen, popoutRequest }: {
  popoutRequest: PopoutRequest | null;
  view: ViewId;
  activateView: (next: ViewId) => void;
  requestGuideTab: (view: ViewId, tab: string) => void;
  aiaTriggerRef: { current: HTMLButtonElement | null };
  setAiaOpen: Dispatch<SetStateAction<boolean>>;
}) {
  // AIA 화면 안내(show_ui_guide): 대상 화면·탭을 열고 요소가 실제로 보일 때까지 기다린 뒤
  // 포인터를 띄운다. false를 돌려주면 팝업이 "찾지 못했다"고 알린다.
  const [uiGuide, setUiGuide] = useState<UiGuideState | null>(null);
  const uiGuideSeq = useRef(0);
  // 클릭·안내가 끝난 뒤의 "지금 화면". 콜백이 만들어질 때의 `view`를 그대로 안내에 실으면,
  // 아이아가 주 메뉴처럼 화면을 바꾸는 요소를 눌렀을 때 안내가 이전 화면 것으로 기록되어
  // 아래 "안내한 화면을 떠나면 거둔다" 효과가 말풍선을 그 자리에서 닫아 버린다.
  const viewRef = useRef(view);
  viewRef.current = view;
  const [aiaGuideYield, setAiaGuideYield] = useState(false);
  const reopenAiaAfterGuideRef = useRef(false);
  const dismissUiGuide = useCallback(() => {
    setUiGuide(null);
    setAiaGuideYield(false);
    if (reopenAiaAfterGuideRef.current) {
      reopenAiaAfterGuideRef.current = false;
      setAiaOpen(true);
    }
  }, [setAiaOpen]);
  // 화면·탭을 열어 달라는 요청을 실행하고, 그 화면 패널이 실제로 보일 때까지 기다린다.
  const openViewForGuide = useCallback(async (viewId: string | null, tab: string | null) => {
    // 전용 창은 대화가 전체를 덮으므로 메뉴·상단바를 찾기 전에 앱 화면을 드러낸다.
    if (document.querySelector(".aia-chat-popup.standalone.open")) {
      reopenAiaAfterGuideRef.current = true;
      setAiaOpen(false);
      await nextFrame();
    }
    if (!viewId || !isViewId(viewId)) return viewId === null;
    activateView(viewId);
    if (tab && UI_GUIDE_VIEW_TABS[viewId]?.includes(tab)) requestGuideTab(viewId, tab);
    return Boolean(await waitForVisibleElement(`[data-view="${viewId}"]`));
  }, [activateView, requestGuideTab, setAiaOpen]);
  const presentUiGuide = useCallback((element: Element, guideView: ViewId | null, label: string, note: string | null) => {
    // 화면보다 긴 대상(설정 화면의 시스템 에이전트 블록 등)을 가운데로 맞추면 머리말도 첫
    // 조작도 없는 중간만 남는다. 그런 대상은 시작 부분부터 보여 준다.
    const tall = element.getBoundingClientRect().height > window.innerHeight - 80;
    element.scrollIntoView({ block: tall ? "start" : "center", inline: "nearest" });
    uiGuideSeq.current += 1;
    setUiGuide({ requestId: uiGuideSeq.current, view: guideView, label, note, element });
  }, []);
  const showUiGuide = useCallback(async (request: Pick<Extract<ChatEvent, { type: "uiGuide" }>, "target" | "element" | "note">) => {
    if (request.target) {
      const target = resolveUiGuideTarget(request.target);
      if (!target) return false;
      await openViewForGuide(target.view, target.tab);
      const element = await waitForVisibleElement(uiGuideAnchorSelector(target.anchor));
      if (!element) return false;
      presentUiGuide(element, target.view, target.description, request.note);
      return true;
    }
    if (request.element) {
      // 등록되지 않은 요소는 지금 화면에서 되찾는다. 스캔 때 붙인 ref가 살아 있으면 그것,
      // 화면이 다시 그려져 사라졌으면 텍스트·역할로 다시 찾는다.
      const element = locateUiElement(request.element);
      if (!element) return false;
      presentUiGuide(element, viewRef.current, request.element.text ?? request.element.ref ?? "", request.note);
      return true;
    }
    return false;
  }, [openViewForGuide, presentUiGuide]);
  // AIA의 요소 조회(find_ui_elements): 요청한 화면·탭을 열고 두 프레임 뒤에 보이는 조작 요소를
  // 스캔해 query에 맞는 것부터 답한다.
  const answerAiaUiQuery = useCallback((event: Extract<ChatEvent, { type: "uiQuery" }>) => {
    void (async () => {
      const opened = await openViewForGuide(event.view, event.tab);
      await nextFrame();
      await nextFrame();
      let candidates = collectVisibleUiElements();
      if (candidates.length === 0 && opened && event.view) {
        // lazy 화면은 패널이 보인 뒤에도 내용이 잠시 늦게 그려진다.
        await waitMs(400);
        candidates = collectVisibleUiElements();
      }
      const elements = rankUiElements(candidates, event.query).map(({ ref, role, text, anchor }) => ({ ref, role, text, anchor }));
      await answerUiQueryQuietly(event.id, elements);
    })();
  }, [openViewForGuide]);
  // 아이아 커서 클릭(open/click_ui_element): 요소를 되찾아 눌러도 되는지 판단하고, 커서를 마지막
  // 위치(처음엔 AIA 트리거)에서 대상까지 움직인 뒤 누른다. 결과와 거절 이유는 그대로 답한다.
  const [uiCursor, setUiCursor] = useState<UiCursorState | null>(null);
  const uiCursorSeq = useRef(0);
  const performAiaUiClick = useCallback((event: Extract<ChatEvent, { type: "uiClick" }>) => {
    void (async () => {
      const element = locateUiElement(event.element);
      if (!element) {
        await answerUiQueryQuietly(event.id, { clicked: false, reason: "요소를 화면에서 찾지 못했습니다. find_ui_elements로 다시 찍어 주세요" });
        return;
      }
      const refusal = uiClickRefusal(element, event.mode);
      if (refusal) {
        await answerUiQueryQuietly(event.id, { clicked: false, reason: refusal });
        return;
      }
      element.scrollIntoView({ block: "center", inline: "nearest" });
      uiCursorSeq.current += 1;
      const seq = uiCursorSeq.current;
      setUiCursor({ ...(uiCursor ?? cursorHomePosition(aiaTriggerRef.current)), pressing: false });
      await nextFrame();
      await nextFrame();
      const rect = element.getBoundingClientRect();
      const target = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      setUiCursor({ ...target, pressing: false });
      await waitMs(700);
      if (uiCursorSeq.current !== seq) return;
      setUiCursor({ ...target, pressing: true });
      await waitMs(120);
      const text = element.getAttribute("aria-label") ?? (element as HTMLElement).innerText?.trim() ?? "";
      activateUiElement(element);
      setUiCursor({ ...target, pressing: false });
      await answerUiQueryQuietly(event.id, { clicked: true, text });
      if (event.note) {
        // 클릭이 화면을 바꿨다면 그 전환이 그려진 뒤의 화면을 안내에 기록해야 말풍선이
        // "막 데려간 화면"의 것으로 남는다. 응답 왕복만으로는 렌더가 끝났다고 보장할 수 없다.
        await nextFrame();
        await nextFrame();
        presentUiGuide(element, viewRef.current, text, event.note);
      }
      await waitMs(1400);
      if (uiCursorSeq.current === seq) setUiCursor(null);
    })();
  }, [aiaTriggerRef, presentUiGuide, uiCursor]);
  // 팝업이 대상을 덮고 있으면 비켜난다. 좁은 화면에서는 팝업이 거의 전체를 덮어 비켜날 곳이
  // 없으므로 잠시 닫고, 안내가 끝나면 다시 연다.
  useEffect(() => {
    if (!uiGuide) return;
    const popup = document.querySelector(".aia-chat-popup.open");
    if (!popup) return;
    const anchor = uiGuide.element.getBoundingClientRect();
    const box = popup.getBoundingClientRect();
    const overlaps = anchor.left < box.right && anchor.right > box.left && anchor.top < box.bottom && anchor.bottom > box.top;
    if (!overlaps) return;
    if (popup.classList.contains("standalone") || window.matchMedia("(max-width: 760px)").matches) {
      reopenAiaAfterGuideRef.current = true;
      setAiaOpen(false);
    } else {
      setAiaGuideYield(true);
    }
  }, [setAiaOpen, uiGuide]);
  // 안내한 화면을 떠나면 포인터도 거둔다.
  useEffect(() => {
    if (uiGuide?.view && uiGuide.view !== view) dismissUiGuide();
  }, [dismissUiGuide, uiGuide, view]);

  // DOM refs from discovery must be consumed by the same main window for guides and clicks.
  type ScreenRequest =
    | { kind: "guide"; event: Parameters<typeof showUiGuide>[0] }
    | { kind: "query"; event: Parameters<typeof answerAiaUiQuery>[0] }
    | { kind: "click"; event: Parameters<typeof performAiaUiClick>[0] };
  const screenHandlers = useRef({ showUiGuide, answerAiaUiQuery, performAiaUiClick });
  screenHandlers.current = { showUiGuide, answerAiaUiQuery, performAiaUiClick };
  const bridge = useRef<ReturnType<typeof createAiaScreenBridge<ScreenRequest>> | null>(null);
  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const connection = createAiaScreenBridge<ScreenRequest>(!popoutRequest, async (request) => {
      if (request.kind === "guide") return screenHandlers.current.showUiGuide(request.event);
      if (request.kind === "query") screenHandlers.current.answerAiaUiQuery(request.event);
      else if (request.kind === "click") screenHandlers.current.performAiaUiClick(request.event);
      else return false;
      return true;
    });
    bridge.current = connection;
    return () => { bridge.current = null; connection.close(); };
  }, [popoutRequest]);
  const routedGuide = useCallback((event: Parameters<typeof showUiGuide>[0]) => popoutRequest?.kind === "aia"
    ? bridge.current?.request({ kind: "guide", event }) ?? Promise.resolve(false)
    : showUiGuide(event), [popoutRequest, showUiGuide]);
  const routedQuery = useCallback((event: Parameters<typeof answerAiaUiQuery>[0]) => {
    if (popoutRequest?.kind !== "aia") return answerAiaUiQuery(event);
    void (bridge.current?.request({ kind: "query", event }) ?? Promise.resolve(false)).then((sent) => {
      if (!sent) void answerUiQueryQuietly(event.id, []);
    });
  }, [popoutRequest, answerAiaUiQuery]);
  const routedClick = useCallback((event: Parameters<typeof performAiaUiClick>[0]) => {
    if (popoutRequest?.kind !== "aia") return performAiaUiClick(event);
    void (bridge.current?.request({ kind: "click", event }) ?? Promise.resolve(false)).then((sent) => {
      if (!sent) void answerUiQueryQuietly(event.id, { clicked: false, reason: "메인 창에 연결하지 못했습니다. 메인 창을 열고 다시 요청해 주세요." });
    });
  }, [popoutRequest, performAiaUiClick]);
  // Test the same routing callbacks that the AIA conversation uses.
  useEffect(() => (e2eHooksEnabled() ? installE2eHooks(window, { showUiGuide: routedGuide, answerAiaUiQuery: routedQuery, performAiaUiClick: routedClick }) : undefined), [routedGuide, routedQuery, routedClick]);
  return { uiGuide, uiCursor, aiaGuideYield, dismissUiGuide, showUiGuide: routedGuide, answerAiaUiQuery: routedQuery, performAiaUiClick: routedClick };
}

/**
 * 아직 열어 본 적 없는 화면은 그리지 않고, 한 번 열린 화면은 숨긴 채 남긴다. 마운트
 * 판정과 패널 껍데기를 화면마다 따로 적으면 열두 줄이 같은 조건을 되풀이하므로 여기서
 * 함께 본다. 내용은 함수로 받아, 마운트되지 않은 화면의 props는 만들지도 않는다.
 */
function ViewPanel({ id, activeView, mounted, children }: { id: ViewId; activeView: ViewId; mounted: Set<ViewId>; children: () => ReactNode }) {
  if (!mounted.has(id)) return null;
  // 경계를 화면마다 따로 둔다. 하나가 실패해도 이미 마운트된 다른 화면은 살아 있어야 한다.
  return <section className={id === "docs" ? "view-panel docs-content" : "view-panel"} data-view={id} hidden={id !== activeView}>
    <ErrorBoundary label={navigationLabel(id, "ko", (ko) => ko)} scope="view">{children()}</ErrorBoundary>
  </section>;
}

function collectProjects(sessions: SessionSummary[]): ProjectOption[] {
  const projects = new Map<string, ProjectOption>();
  for (const session of sessions) {
    const path = session.cwd;
    // AIA 작업공간은 앱이 쓰는 내부 경로다. 목록에는 보여도 새 작업을 시작할 프로젝트는 아니다.
    if (!path || session.meta.hidden || session.aiaWorkspace) continue;
    const updatedAt = session.updatedAt ?? 0;
    const known = projects.get(path);
    if (known) {
      known.count += 1;
      if (updatedAt > known.updatedAt) known.updatedAt = updatedAt;
      continue;
    }
    projects.set(path, { name: session.project ?? path, path, count: 1, updatedAt });
  }
  return [...projects.values()].sort((left, right) => right.updatedAt - left.updatedAt || right.count - left.count);
}

function aiaEventStillActive(event: AiaEvent, baseline: AiaEventBaseline): boolean {
  if (event.kind === "cliLost") return baseline.cliMissing.includes(event.targetId);
  if (event.kind === "accountAuthError") return baseline.authErrors[event.targetId] !== undefined;
  if (event.kind === "scheduleRecoveryError") return baseline.scheduleProblems[event.targetId]?.endsWith("recovery-error") ?? false;
  if (event.kind === "scheduleFailed") return baseline.scheduleProblems[event.targetId] !== undefined;
  return baseline.translationFailures[event.targetId] !== undefined;
}

/** 로케일이 한국어면 원문 그대로, 아니면 번역 훅에 맡긴다. */
function navigationText([ko, en]: [string, string], locale: string, translate: (ko: string, en: string) => string): string {
  return locale === "ko" ? ko : translate(ko, en);
}

function navigationLabel(view: ViewId, locale: string, translate: (ko: string, en: string) => string): string {
  return navigationText(NAVIGATION[view].label, locale, translate);
}

function navigationTitle(view: ViewId, locale: string, translate: (ko: string, en: string) => string): string {
  const entry = NAVIGATION[view];
  return navigationText(entry.title ?? entry.label, locale, translate);
}

export default App;
