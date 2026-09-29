import { lazy, memo, Suspense, useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type MutableRefObject, type ComponentType, type ReactNode, type SetStateAction } from "react";
import "./App.css";
import type { ChatTab } from "./components/ChatView";
import type { SettingsTabId } from "./components/SettingsView";
import type { WorkflowsTabId } from "./components/WorkflowsView";
import type { AddonsTabId } from "./components/AddonsView";
import type { ProjectsTabId } from "./components/ProjectsView";
import type { StorageTabId } from "./components/StorageView";
import { UiGuidePointer } from "./components/UiGuidePointer";
import type { TabRequest } from "./lib/uiGuide";
import { UiCursor } from "./components/UiCursor";
import { FileDownloadProgress } from "./components/FileDownloadProgress";
import { AppToastStack, useAppToasts } from "./components/AppToasts";
import { AiaTopbarTrigger } from "./components/AiaTopbarTrigger";
import { errorText } from "./lib/errorText";
import { ChatAttentionCenter } from "./components/ChatAttentionCenter";
import { NewProjectsModal } from "./components/NewProjectsModal";
import { DashboardView } from "./components/DashboardView";
import { ErrorBanner, HelpHint, LoadingState, LogoMark, useConfirm } from "./components/Shared";
import {
  getAntigravityUsage,
  getManagerSnapshot,
  getManagerSnapshotSync,
  getProviderAccounts,
  BackendBusyError,
  getCatalogHealth,
  getCliUpdateStatus,
  getSchedulerSnapshot,
  getSessionSummary,
  getShutdownImpact,
  getSystemAutomationSnapshot,
  hasTauriRuntime,
  respondToQuit,
  reconcileSessionCatalog,
  refreshProviderAccountUsages,
  refreshSessionCatalog,
  RemoteConnectionError,
  setSchedulesPaused,
  getLocalLlmConnections,
} from "./lib/ipc";
import { SESSION_SYNC_DELAYS_MS, sessionSyncKey, unindexedRunTargets } from "./lib/sessionSyncBudget";
import { aiaAttentionForChat, selectAiaAttention, withoutAiaAttention } from "./lib/aiaAttention";
import { aiaRuntimeProvider } from "./lib/aiaRuntime";
import { navigationHelpEmphasis, navigationHelpParagraphs } from "./lib/navigationHelp";
import { loadNavigationPreferences, saveNavigationPreferences, type NavigationPreferences } from "./lib/navigationPreferences";
import { accountUsageDisplayState, elapsedResetSignature, usageRefreshDeferred, usageRefreshInterval, usageResetElapsedSinceUpdate } from "./lib/accountUsage";
import { homeUsageCanRefresh, homeUsageRefreshDue } from "./lib/homeAccount";
import { notifyExpiringCredentials } from "./lib/webNotifications";
import { sidebarUsageSources } from "./lib/sidebarUsage";
import type { SidebarUsageDensity } from "./lib/sidebarUsage";
import { useI18n } from "./lib/i18n";
import { collectRecentModels } from "./lib/recentModels";
import { dedupeManagerSnapshot } from "./lib/sessionCatalog";
import { mergeManagerSnapshot } from "./lib/managerSnapshot";
import { catalogRefreshNeeded } from "./lib/catalogHealth";
import { recountSessionFolders } from "./lib/sessionFolders";
import { usePoll } from "./lib/poll";
import { refreshProviderOptions } from "./lib/providerOptions";
import { discoveryRequestKey, rememberDiscoveryRequests, schemaDiscoveryPrompt, staleCatalogSources } from "./lib/schemaDiscovery";
import { parsePopoutRequest } from "./lib/popout";
import { closePopoutWindow } from "./lib/popoutWindow";
import { loadAccentColor, loadThemeMode } from "./lib/theme";
import { checkAppVersion, shouldCheckAppVersion, type AppVersionManifest } from "./lib/appUpdate";
import { listen } from "@tauri-apps/api/event";
import { AppStatusbar } from "./components/AppStatusbar";
import { AppSidebar, navigationLabel, navigationTitle } from "./components/AppSidebar";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { useAiaSuggestionCenter } from "./appAiaSuggestions";
import { useAiaScreenControl } from "./appAiaScreenControl";
import { useAiaPopupShell, useAiaRuntime } from "./appAiaPopup";
import { useNewProjectsPrompt } from "./appNewProjects";
import { useChatAttentionCenter } from "./appChatAttention";
import { keepIfSame } from "./appStateIdentity";
import {
  activeViewStore,
  catalogDiscoveryStore,
  initialMainView,
  messageDisplayModeStore,
  persistAccentColor,
  persistThemeMode,
  sessionTranscriptLimitStore,
  sidebarUsageDensityStore,
  useStoredState,
} from "./appStoredState";
import type { AccountSnapshot, AccountUsageView, AccentColor, LocalLlmConnection, CatalogHealth, ManagerSnapshot, MessageDisplayMode, ProjectOption, ProviderId, ProviderStatus, SchedulerSnapshot, SessionFolder, SessionMeta, SessionSummary, SessionTranscriptLimit, SystemAutomationSnapshot, ThemeMode, TranslationStatus, ViewId } from "./types";

/** 사이드바 Antigravity 사용량 폴링 주기. 백엔드가 30초 캐시를 두므로 그보다 자주 두드릴 이유가 없다. */
const ANTIGRAVITY_USAGE_POLL_MS = 60_000;

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
 * 이름 붙은 export 하나를 지연 로딩한다. `lazy`는 default export를 기대하지만 이 저장소의
 * 화면·팝업은 모두 이름 붙은 export라, 모듈에서 그 이름을 꺼내 default로 바꿔 주는 한 줄이
 * 부르는 자리마다 되풀이됐다.
 *
 * `wrap`은 받아 온 컴포넌트를 감싸는 자리다 — 화면은 memo로 감싸 다른 화면의 갱신에
 * 휩쓸리지 않게 하고(`lazyMemoView`), 팝업은 그대로 쓴다.
 */
function lazyNamed<K extends string, P>(
  load: () => Promise<Record<K, ComponentType<P>>>,
  name: K,
  wrap: (component: ComponentType<P>) => ComponentType<P> = (component) => component,
) {
  return lazy(async () => ({ default: wrap((await load())[name]) }));
}

/** 화면 번들. 받은 뒤 memo로 감싼다 — 열두 화면이 같은 모양을 적던 것을 이 한 벌로 모은다. */
function lazyMemoView<K extends string, P>(load: () => Promise<Record<K, ComponentType<P>>>, name: K) {
  return lazyNamed(load, name, memo);
}
const MemoChatView = lazyMemoView(() => import("./components/ChatView"), "ChatView");
const MemoSessionsView = lazyMemoView(() => import("./components/SessionsView"), "SessionsView");
const MemoDocsView = lazyMemoView(() => import("./components/DocsView"), "DocsView");
const MemoProjectsView = lazyMemoView(() => import("./components/ProjectsView"), "ProjectsView");
const MemoInstructionsView = lazyMemoView(() => import("./components/InstructionsView"), "InstructionsView");
const MemoSkillsView = lazyMemoView(() => import("./components/SkillsView"), "SkillsView");
const MemoAgentsView = lazyMemoView(() => import("./components/AgentsView"), "AgentsView");
const MemoArtifactsView = lazyMemoView(() => import("./components/ArtifactsView"), "ArtifactsView");
const MemoWorkflowsView = lazyMemoView(() => import("./components/WorkflowsView"), "WorkflowsView");
const MemoAddonsView = lazyMemoView(() => import("./components/AddonsView"), "AddonsView");
const MemoStorageView = lazyMemoView(() => import("./components/StorageView"), "StorageView");
const MemoSettingsView = lazyMemoView(() => import("./components/SettingsView"), "SettingsView");
const AiaChatPopup = lazyNamed(() => import("./components/AiaChatPopup"), "AiaChatPopup");
const CliConnectionDrawer = lazyNamed(() => import("./components/CliConnectionDrawer"), "CliConnectionDrawer");

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

/**
 * 셸(트레이·메뉴)이 보내는 이벤트 하나를 구독한다.
 *
 * 구독은 비동기라 해제 함수가 효과가 끝난 뒤에 도착할 수 있다. 그때 그냥 두면 화면이
 * 사라진 뒤에도 핸들러가 살아 있으므로, 도착 시점에 이미 끝난 효과였다면 받자마자 끊어야
 * 한다. 구독 실패(웹에서 연 창 등)는 삼킨다 — 셸 이벤트는 없어도 화면이 도는 부가 통로다.
 *
 * 핸들러는 ref로 붙들어 매 렌더 새 함수가 와도 구독을 다시 세우지 않는다. 이벤트 이름은
 * 고정값이므로 구독은 마운트 한 번으로 끝난다.
 */
function useShellEvent(event: string, handler: () => void): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  useEffect(() => {
    if (!hasTauriRuntime()) return undefined;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen(event, () => { handlerRef.current(); })
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [event]);
}

function App() {
  const { locale, setLocale, text } = useI18n();
  const [appVersionManifest, setAppVersionManifest] = useState<AppVersionManifest | null>(null);
  useEffect(() => {
    let disposed = false;
    const check = () => {
      if (!shouldCheckAppVersion()) return;
      void checkAppVersion().then((result) => {
        if (!disposed && result.manifest) setAppVersionManifest(result.manifest);
      });
    };
    check();
    const timer = window.setInterval(check, 60 * 60 * 1000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, []);
  const [snapshot, setSnapshot] = useState<ManagerSnapshot | null>(null);
  const [automation, setAutomation] = useState<SystemAutomationSnapshot | null>(null);
  // 채팅·설정 화면은 마운트된 채 유지되므로, 특정 탭을 열려면 requestId를 새로 매긴 요청을
  // 내려 보낸다(대시보드 반복 일정, 사이드바 CLI 상태, AIA 화면 안내가 쓴다).
  const tabRequestSeq = useRef(0);
  const nextRequestId = useCallback(() => (tabRequestSeq.current += 1), []);
  const [chatTabRequest, requestChatTab] = useTabRequest<ChatTab>(nextRequestId);
  const [settingsTabRequest, requestSettingsTab] = useTabRequest<SettingsTabId>(nextRequestId);
  const [workflowsTabRequest, requestWorkflowsTab] = useTabRequest<WorkflowsTabId>(nextRequestId);
  const [addonsTabRequest, requestAddonsTab] = useTabRequest<AddonsTabId>(nextRequestId);
  const [projectsTabRequest, requestProjectsTab] = useTabRequest<ProjectsTabId>(nextRequestId);
  const [storageTabRequest, requestStorageTab] = useTabRequest<StorageTabId>(nextRequestId);
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
  const [messageDisplayMode, setMessageDisplayMode] = useStoredState<MessageDisplayMode>(messageDisplayModeStore.load, messageDisplayModeStore.save);
  const [navigationPreferences, setNavigationPreferences] = useStoredState<NavigationPreferences>(loadNavigationPreferences, saveNavigationPreferences);
  // 대화 원문 표시 범위는 세션 상세와 채팅이 함께 쓴다. 한쪽에서 바꾸면 다른 쪽도 같은 범위가
  // 되도록 messageDisplayMode와 같은 방식으로 App이 소유한다.
  const [transcriptLimit, setTranscriptLimit] = useStoredState<SessionTranscriptLimit>(sessionTranscriptLimitStore.load, sessionTranscriptLimitStore.save);
  const [themeMode, setThemeMode] = useStoredState<ThemeMode>(loadThemeMode, persistThemeMode);
  const [sidebarUsageDensity, setSidebarUsageDensity] = useStoredState<SidebarUsageDensity>(sidebarUsageDensityStore.load, sidebarUsageDensityStore.save);
  const [accentColor, setAccentColor] = useStoredState<AccentColor>(loadAccentColor, persistAccentColor);
  const [selectedSession, setSelectedSession] = useState<SessionSummary | null>(null);
  const { error, setError } = useAppErrorBanner();
  const { toasts, pushToast, dismissToast } = useAppToasts();
  const [reconnecting, setReconnecting] = useState(false);
  const [appRefreshing, setAppRefreshing] = useState(false);
  const [setupProviderId, setSetupProviderId] = useState<ProviderId | null>(null);
  const snapshotRef = useRef<ManagerSnapshot | null>(null);
  const automationRef = useRef<SystemAutomationSnapshot | null>(null);
  const wasReconnecting = useRef(false);
  // AIA 팝업의 열림·마운트·바쁨과 자동 요청 한 줄기는 훅 하나가 통째로 맡는다.
  const {
    aiaOpen,
    setAiaOpen,
    aiaMounted,
    keepMounted: keepAiaMounted,
    aiaBusy,
    setAiaBusy,
    aiaTriggerRef,
    aiaAutoPrompt,
    openAia,
    requestAiaPrompt,
    handleAiaAutoPrompt,
  } = useAiaPopupShell({ popoutRequest, automationRef });

  // 웹 모드에서 원격 서버에 닿지 못한 실패는 오류 배너 대신 재연결 상태로 표시한다.
  const reportFailure = useCallback((cause: unknown) => {
    if (cause instanceof RemoteConnectionError) {
      setReconnecting(true);
      if (!snapshotRef.current) setError(cause.message);
      return;
    }
    setError(errorText(cause));
  }, []);

  /**
   * 화면이 먼저 반영하는 부분 수정(세션 메타·폴더)을 스냅샷에 얹는다.
   *
   * `snapshotRef`는 이제 변경분을 합칠 기준이기도 하므로 상태만 바꾸고 ref를 두면 다음
   * 변경분이 낡은 목록 위에 얹힌다. 두 곳을 한 번에 갱신해 항상 같은 것을 가리키게 한다.
   */
  const applySnapshot = useCallback((update: (current: ManagerSnapshot) => ManagerSnapshot) => {
    const current = snapshotRef.current;
    if (!current) return;
    const next = update(current);
    snapshotRef.current = next;
    setSnapshot(next);
  }, []);

  const refresh = useCallback(async (propagateError = false) => {
    setError(null);
    try {
      // 이미 목록을 들고 있으면 개정 이후 변경분만 받아 합친다. 세션 2,500건 규모에서 전체
      // 스냅숏은 3.4MB인데 한 회차에 실제로 달라지는 세션은 대개 한두 건이고, 전부 다시
      // 받으면 바뀌지 않은 행까지 새 객체가 돼 목록 전체가 다시 그려졌다. 첫 기동은 미리
      // 직렬화해 둔 전체 스냅숏 응답이 더 빠르므로 그대로 전체를 받는다.
      const previous = snapshotRef.current;
      const next = dedupeManagerSnapshot(previous
        ? mergeManagerSnapshot(previous, await getManagerSnapshotSync(previous.sessionCatalogRevision))
        : await getManagerSnapshot());
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

  // 세션 색인 한 벌 — 목록 전체 조정, 실행 한 건의 색인 추적, 색인 상태 폴링은
  // useSessionCatalogCenter가 통째로 맡는다. App 본문은 색인 상태와 두 창구, 그리고
  // 반복 일정이 함께 보는 포기 목록만 받아 쓴다.
  const { catalogHealth, reconcileSessionList, syncSessionCatalog, abandonedSessionSyncs } = useSessionCatalogCenter({
    snapshotRef,
    sessionsViewActive: view === "sessions",
    refresh,
    reportFailure,
  });

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
        // 목록에서 제외한 프로젝트의 세션은 색인이 일부러 올리지 않는다. 팝아웃은 세션
        // 하나만 띄우는 창이라 목록 여부와 무관하게 원본으로 연다.
        session = find() ?? await getSessionSummary(source, sessionId).catch(() => null);
      }
      if (!session) {
        setError("요청한 세션의 기록을 찾지 못했습니다.");
        return;
      }
      setSelectedSession(session);
    })().catch((cause: unknown) => setError(errorText(cause)));
  }, [snapshot, popoutRequest, syncSessionCatalog]);

  // 팝아웃 창의 임시 제목. 대상 이름을 알기 전까지만 쓰고, 화면이 대상을 열면
  // usePopoutWindowTitle이 실제 이름으로 바꾼다. 나중에 다시 덮지 않도록 한 번만 설정한다.
  useEffect(() => {
    if (!popoutRequest) return;
    document.title = popoutRequest.kind === "aia" ? "AIA · Agent Manager" : popoutRequest.kind === "chat" ? `${text("채팅", "Chat")} · Agent Manager` : `${text("세션", "Session")} · Agent Manager`;
  }, [popoutRequest, text]);

  // 연결이 복구되면 끊긴 사이의 변경을 다시 읽고, 남아 있던 일시 오류 배너도 함께 정리한다.
  useEffect(() => {
    if (wasReconnecting.current && !reconnecting) void refresh();
    wasReconnecting.current = reconnecting;
  }, [reconnecting, refresh]);

  // 계정 폴링이 성공했다는 것은 연결이 살아 있다는 뜻이다. 스냅샷을 이미 들고 있으면
  // 남아 있던 일시 오류 배너도 함께 걷는다. 연결·오류 표시는 App이 소유한다.
  const markBackendReachable = useCallback(() => {
    setReconnecting(false);
    if (snapshotRef.current) setError(null);
  }, []);

  const antigravityDetected = Boolean(snapshot?.status.providers.some((provider) => (
    provider.provider === "antigravity" && provider.cli.detected
  )));
  // 로컬 공급자는 계정 스냅샷에 없어 상태바가 연결 설정을 직접 읽는다. 사용량이 없으므로
  // 주기 폴링도 필요 없다 — 한 번 읽고, 설정 화면에서 바꾸면 다음 기동에 반영된다.
  const [localConnection, setLocalConnection] = useState<LocalLlmConnection | null>(null);
  useEffect(() => {
    let alive = true;
    // 연결이 여럿이라(M7) 켜진 것 하나를 골라 상태바에 세운다. 없으면 로컬 줄이 서지 않는다.
    void getLocalLlmConnections()
      .then((next) => {
        if (!alive) return;
        setLocalConnection(next.connections.find((entry) => entry.enabled && entry.baseUrl.trim() !== "") ?? null);
      })
      .catch(() => undefined);
    return () => { alive = false; };
  }, []);
  // 계정 스냅샷 폴링·사용량 재조회 판정·Antigravity 별도 조회·상태 카드 새로고침은
  // useAccountUsageCenter가 통째로 맡는다. App 본문은 값과 새로고침 창구만 쓴다.
  const { accounts, setAccounts, antigravityUsage, statusRefreshing, refreshStatusCard } = useAccountUsageCenter({
    antigravityDetected,
    refresh,
    reportFailure,
    onAccountsLoaded: markBackendReachable,
  });


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

  // 반복 일정 목록 폴링·트레이 일시정지 토글·완료 실행 색인 추적은 useSchedulerCenter가
  // 통째로 맡는다. App 본문은 목록과 세 창구만 화면에 꽂는다.
  const { schedulerSnapshot, refreshScheduler, applySchedulerSnapshot } = useSchedulerCenter({
    sessions: snapshot?.sessions,
    syncSessionCatalog,
    abandonedSessionSyncs,
    reportFailure,
  });

  // 종료 확인 창은 시작 화면·오류 화면에서도 떠야 한다. 셸은 그 화면에서도 종료 의사를
  // 넘기고, 창이 보이지 않으면 사용자에게는 앱이 꺼지지 않는 것으로만 보인다.
  const quitConfirmDialog = useQuitConfirmation(text);


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
  // 공통 저장소 경로·프로젝트 활성여부가 바뀌면 스킬·지침 화면이 다시 읽고 스냅샷도 다시 받는다.
  const invalidateResourceViews = useCallback(() => {
    setResourceRepositoryRevision((current) => current + 1);
    void refresh();
  }, [refresh]);
  // 새로 감지된 프로젝트의 초기값(활성 유지/제외)을 묻는 알림창은 useNewProjectsPrompt가
  // 통째로 맡는다. App 본문은 목록과 네 창구, 띄울지 여부만 화면에 꽂는다.
  const newProjects = useNewProjectsPrompt({
    snapshot,
    popoutRequest,
    onDecided: invalidateResourceViews,
  });
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
    requestSettingsTab("aia");
    setSystemAgentNoticeRequest(nextRequestId());
    activateView("settings");
  }, [activateView, nextRequestId, requestSettingsTab]);

  // 알림창의 상태·폴링·라우팅은 useChatAttentionCenter가 통째로 맡는다.
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
    requestWorkflowsTab,
    syncSessionCatalog,
    setSelectedSession,
    setError,
    notify: pushToast,
    openAia,
  });

  const { aiaProviderId, aiaRuntime } = useAiaRuntime(automation);

  // 제안 카탈로그·스킬 변경 감지·운영 사건 분석을 합쳐 트리거에 띄울 제안 목록을
  // 만드는 일은 useAiaSuggestionCenter가 통째로 맡는다.
  const { aiaSuggestions, dismissSuggestion, refreshSuggestionCatalog } = useAiaSuggestionCenter({
    aiaProviderId,
    aiaOpen,
    popoutRequest,
    snapshot,
    accounts,
    scheduler: schedulerSnapshot,
    automation,
    attention: chatAttention,
  });

  // 스킬·지침·애드온을 고치면 목록 스냅샷과 제안 카탈로그가 함께 낡는다. 세 화면이 각자
  // 적던 다시 읽기를 한 자리로 모은다. 지침 화면은 공통 저장소 경로까지 바뀔 수 있어
  // 자원 화면 무효화가 한 겹 더 붙는다.
  const reloadChangedResources = useCallback(() => {
    void refresh();
    void refreshSuggestionCatalog();
  }, [refresh, refreshSuggestionCatalog]);
  const reloadChangedInstructions = useCallback(() => {
    invalidateResourceViews();
    void refreshSuggestionCatalog();
  }, [invalidateResourceViews, refreshSuggestionCatalog]);

  // AIA가 꺼져 있으면 열 수 있는 대화가 없으므로 남은 알림도 트리거에 표시하지 않는다.
  const aiaAttention = aiaProviderId ? selectAiaAttention(chatAttention.items) : null;
  const visibleChatAttention = withoutAiaAttention(chatAttention);
  // 페이싱 제안은 알림창과 페이싱 탭 두 곳에 같은 목록으로 뜬다. 알림에서 탭으로 넘어온
  // 사용자가 무엇을 보고 조정해야 하는지 그 화면에서 바로 읽게 하려는 것이다.
  const pacingSuggestions = chatAttention.items.filter((item) => item.kind === "pacingSuggestion");
  // 창 크롬과 앱을 가르는 셸 상단선은 AIA나 에이전트가 도는 동안 놋빛 띠를 흘린다.
  // 실행 중 알림은 턴이 끝나면 같은 id로 덮이고 세션이 끝나면 걷히므로(백엔드
  // `replace_attention_item`), 이 목록에 running이 남아 있는 것이 곧 "도는 중"이다.
  const shellBusy = aiaBusy || chatAttention.items.some((item) => item.kind === "running");
  const toggleAia = useCallback(() => {
    if (aiaAttention) {
      openAttentionItem(aiaAttention);
      return;
    }
    setAiaOpen((current) => !current);
  }, [aiaAttention, openAttentionItem]);

  // 팝업이 버린 대화(새 대화 시작·실행설정 어긋남으로 정지)의 알림은 함께 걷는다. 남겨
  // 두면 미확인 알림이 트리거를 그 대화로 돌려보내(`toggleAia`), 새로 시작한 대화를 닫았다
  // 열었을 때 방금 버린 대화가 도로 열린다.
  const discardAiaChat = useCallback((chatId: string) => {
    const items = aiaAttentionForChat(chatAttention.items, chatId);
    if (items.length > 0) void dismissAttention(items);
  }, [chatAttention.items, dismissAttention]);

  // 알림이 오면 팝업 번들을 미리 받아 둔다. 지연 로딩을 기다리는 사이 안 열린 줄 알고
  // 다시 누르는 일을 막는다. open=false로 마운트해도 대화를 시작하지는 않는다.
  useEffect(() => {
    if (aiaAttention) keepAiaMounted();
  }, [aiaAttention, keepAiaMounted]);

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
    if (guideView === "projects") requestProjectsTab(tab as ProjectsTabId);
    if (guideView === "storage") requestStorageTab(tab as StorageTabId);
  }, [requestAddonsTab, requestChatTab, requestProjectsTab, requestSettingsTab, requestStorageTab, requestWorkflowsTab]);
  const {
    uiGuide,
    uiCursor,
    aiaGuideYield,
    dismissUiGuide,
    showUiGuide,
    answerAiaUiQuery,
    performAiaUiClick,
  } = useAiaScreenControl({ view, activateView, requestGuideTab, aiaTriggerRef, setAiaOpen, popoutRequest });

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
    applySnapshot((current) => {
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
  }, [applySnapshot]);

  // 폴더 삭제는 하위 트리까지 함께 지우므로 배정 정리도 지워진 ID 전체를 기준으로 한다.
  const updateFolders = useCallback((folders: SessionFolder[], deletedFolderIds?: string[]) => {
    const deleted = deletedFolderIds && deletedFolderIds.length > 0 ? new Set(deletedFolderIds) : null;
    applySnapshot((current) => {
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
  }, [applySnapshot]);

  if (!snapshot && !error) {
    return (
      <main className="launch-screen">
        <LogoMark size={64} />
        <h1>Agent Manager</h1>
        <LoadingState label={reconnecting
          ? text("서버와 다시 연결하는 중…", "Reconnecting to the server…")
          : text("로컬 에이전트 데이터를 인덱싱하고 있습니다", "Indexing local agent data")} />
        {quitConfirmDialog}
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
        {quitConfirmDialog}
      </main>
    );
  }

  const title = navigationTitle(view, locale, text);
  // 강조 문단은 있는 화면이 드물어 도움말 본문과 따로 뽑는다(없으면 null).
  const helpEmphasis = navigationHelpEmphasis(view, text);
  const setupProvider = setupProviderId
    ? snapshot.status.providers.find((provider) => provider.provider === setupProviderId) ?? null
    : null;
  const aiaProvider = aiaProviderId
    ? snapshot.status.providers.find((provider) => provider.provider === aiaProviderId) ?? null
    : null;
  const skillTransferAiaAvailable = Boolean(aiaProviderId && aiaProvider?.cli.detected);
  const sidebarUsage = sidebarUsageSources(accounts, antigravityDetected ? antigravityUsage : null, localConnection);
  /**
   * 화면 패널 한 장. 열둘이 모두 지금 열린 화면과 마운트 목록을 받아야 하는데, 그 두 값은
   * 패널마다 다르지 않다 — 여기서 한 번만 묶어 화면별로 다른 것(무엇을 그리는가)만 남긴다.
   */
  const panel = (id: ViewId, render: () => ReactNode) => (
    <ViewPanel id={id} activeView={view} mounted={mountedViews}>{render}</ViewPanel>
  );

  return (
    <div className={`manager-shell${aiaVisible && aiaProviderId ? " aia-open" : ""}${popoutRequest ? " popout" : ""}${popoutRequest?.kind === "aia" ? " aia-popout" : ""}${shellBusy ? " busy" : ""}`}>
      <AppSidebar
        view={view}
        sessionCount={snapshot.dashboard.sessionCount}
        refreshing={appRefreshing}
        preferences={navigationPreferences}
        onActivate={activateView}
        onRefresh={() => { void refreshApp(); }}
      />

      <section className="app-content">
        <header className="topbar">
          <h1>{title}<HelpHint
            label={locale === "ko" ? `${title} 메뉴 설명` : `${title} menu details`}
            title={locale === "ko" ? `${title} 메뉴` : `${title} menu`}
            popoverClassName={view === "skills" || view === "instructions" ? "skill-menu-help-popover" : undefined}
          >{navigationHelpParagraphs(view, text).map((paragraph) => <span className="help-hint-paragraph" key={paragraph}>{paragraph}</span>)}{helpEmphasis && <strong className="help-hint-emphasis">{helpEmphasis}</strong>}</HelpHint></h1>
          <div className="topbar-actions">
            <AiaTopbarTrigger
              triggerRef={aiaTriggerRef}
              enabled={Boolean(aiaProviderId)}
              popupOpen={aiaOpen}
              popupVisible={aiaVisible}
              busy={aiaBusy}
              attention={aiaAttention}
              suggestions={aiaSuggestions}
              guideActive={Boolean(uiCursor || uiGuide)}
              onToggle={toggleAia}
              onOpenSettings={openSystemAgentSettings}
            />
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
          {panel("dashboard", () => <MemoDashboardView snapshot={snapshot} scheduler={schedulerSnapshot} attention={visibleChatAttention} accounts={accounts} onOpenSession={openSession} onOpenSchedules={openSchedules} onConnectCli={connectCli} />)}
          {panel("chat", () => <MemoChatView providers={snapshot.status.providers} accounts={accounts} projects={projectOptions} models={modelOptions} sessions={snapshot.sessions} messageDisplayMode={messageDisplayMode} transcriptLimit={transcriptLimit} onTranscriptLimitChange={setTranscriptLimit} scheduler={schedulerSnapshot} onRefreshScheduler={refreshScheduler} onSchedulerSnapshot={applySchedulerSnapshot} tabRequest={chatTabRequest} onConnectCli={connectCli} onOpenSession={openSession} onMetaChanged={updateSessionMeta} onSessionCatalogChanged={syncSessionCatalog} attentionTarget={chatViewAttentionTarget} onAttentionTargetHandled={clearChatViewAttentionTarget} popout={Boolean(popoutRequest)} />)}
          {panel("sessions", () => <MemoSessionsView providers={snapshot.status.providers} sessions={snapshot.sessions} folders={snapshot.folders} catalogHealth={catalogHealth} onRefreshList={reconcileSessionList} selected={selectedSession} messageDisplayMode={messageDisplayMode} transcriptLimit={transcriptLimit} onTranscriptLimitChange={setTranscriptLimit} onSelect={selectSession} onMetaChanged={updateSessionMeta} onFoldersChanged={updateFolders} onSessionCatalogChanged={syncSessionCatalog} attentionTarget={sessionAttentionTarget} onAttentionTargetHandled={clearSessionAttentionTarget} popout={Boolean(popoutRequest)} />)}
          {panel("docs", () => <MemoDocsView providers={snapshot.status.providers} accounts={accounts} models={modelOptions} onRequestAiaPrompt={requestAiaPrompt} />)}
          {panel("projects", () => <MemoProjectsView active={view === "projects"} tabRequest={projectsTabRequest} registryRevision={resourceRepositoryRevision} onRegistryChanged={invalidateResourceViews} />)}
          {panel("instructions", () => <MemoInstructionsView onChanged={reloadChangedInstructions} onRequestAiaPrompt={requestAiaPrompt} repositoryRevision={resourceRepositoryRevision} automation={automation} onAutomationChange={applyAutomationChange} />)}
          {panel("skills", () => <MemoSkillsView active={view === "skills"} skills={snapshot.skills} automation={automation} onAutomationChange={applyAutomationChange} onSkillsChanged={reloadChangedResources} onRequestAiaPrompt={requestAiaPrompt} aiaTransferAvailable={skillTransferAiaAvailable} catalogHealth={catalogHealth} repositoryRevision={resourceRepositoryRevision} />)}
          {panel("agents", () => <MemoAgentsView agents={snapshot.agents} automation={automation} onAutomationChange={applyAutomationChange} catalogHealth={catalogHealth} />)}
          {panel("artifacts", () => <MemoArtifactsView groups={snapshot.artifacts} automation={automation} onAutomationChange={applyAutomationChange} catalogHealth={catalogHealth} />)}
          {panel("workflows", () => <MemoWorkflowsView active={view === "workflows"} onRequestAiaPrompt={requestAiaPrompt} tabRequest={workflowsTabRequest} pacingSuggestions={pacingSuggestions} />)}
          {panel("addons", () => <MemoAddonsView active={view === "addons"} tabRequest={addonsTabRequest} automation={automation} onAutomationChange={applyAutomationChange} onSkillsChanged={reloadChangedResources} onRequestAiaPrompt={requestAiaPrompt} />)}
          {panel("storage", () => <MemoStorageView active={view === "storage"} tabRequest={storageTabRequest} />)}
          {panel("settings", () => <MemoSettingsView active={view === "settings"} providers={snapshot.status.providers} accounts={accounts} models={modelOptions} onAccountsChange={setAccounts} onConnectCli={connectCli} themeMode={themeMode} onThemeModeChange={setThemeMode} accentColor={accentColor} onAccentColorChange={setAccentColor} navigationPreferences={navigationPreferences} onNavigationPreferencesChange={setNavigationPreferences} messageDisplayMode={messageDisplayMode} onMessageDisplayModeChange={setMessageDisplayMode} automation={automation} onAutomationChange={applyAutomationChange} onRequestAiaPrompt={requestAiaPrompt} tabRequest={settingsTabRequest} systemAgentNoticeRequest={systemAgentNoticeRequest} appVersionManifest={appVersionManifest} onRepositoryChanged={invalidateResourceViews} />)}
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
      {newProjects.visible && <NewProjectsModal
        projects={newProjects.pendingProjects}
        busyPath={newProjects.busyPath}
        failure={newProjects.failure}
        onDecide={(entry, active) => { void newProjects.decide(entry, active); }}
        onKeepAll={() => { void newProjects.keepAll(); }}
        onLater={newProjects.defer}
      />}
      {setupProvider && <ErrorBoundary label="CLI 연결" scope="view"><Suspense fallback={null}><CliConnectionDrawer
        provider={setupProvider}
        platform={snapshot.status.platform}
        onClose={() => setSetupProviderId(null)}
        onRefresh={async () => {
          // 스냅숏은 백엔드가 이미 들고 있는 탐지 결과를 그대로 읽어 온다. "다시 검사"가
          // 방금 설치한 CLI를 찾으려면 탐지를 실제로 다시 돌리는 조회를 먼저 불러야
          // 한다. 그 조회가 스냅숏의 탐지 상태까지 맞춰 주므로 이어지는 갱신이 새 결과를
          // 싣는다. 조회가 실패해도 갱신 자체는 막지 않는다.
          await getCliUpdateStatus().catch(() => undefined);
          await refresh(true);
        }}
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
        onDiscardChat={discardAiaChat}
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
      {uiGuide && <UiGuidePointer key={uiGuide.requestId} requestId={uiGuide.requestId} anchor={uiGuide.element} note={uiGuide.note} label={uiGuide.label} onDismiss={dismissUiGuide} />}
      {uiCursor && <UiCursor state={uiCursor} />}
      <FileDownloadProgress />
      <AppToastStack toasts={toasts} onDismiss={dismissToast} />
      {quitConfirmDialog}
    </div>
  );
}

/**
 * 실패 배너가 최소한 이만큼은 화면에 남는다. 배너를 거두는 쪽(연결 회복·계정 폴링 성공·
 * 다음 목록 갱신)은 2~3초 주기로 돌기 때문에, 실패 직후에 그 회차가 한 번 지나가면
 * 사용자가 읽기도 전에 배너가 사라졌다.
 */
const MIN_ERROR_VISIBLE_MS = 7_000;

/**
 * 화면 위쪽 실패 배너의 문구 한 칸. 세우는 일은 그대로 즉시 반영하고, **거두는 일만**
 * 최소 표시 시간까지 미룬다. 미루는 동안 새 실패가 들어오면 예약된 철거는 취소된다.
 */
function useAppErrorBanner() {
  const [error, setErrorMessage] = useState<string | null>(null);
  const shownAt = useRef(0);
  const clearTimer = useRef<number | null>(null);
  const current = useRef<string | null>(null);

  const setError = useCallback((message: string | null) => {
    if (clearTimer.current !== null) {
      window.clearTimeout(clearTimer.current);
      clearTimer.current = null;
    }
    if (message !== null) {
      shownAt.current = Date.now();
      current.current = message;
      setErrorMessage(message);
      return;
    }
    if (current.current === null) return;
    const shownFor = Date.now() - shownAt.current;
    if (shownFor >= MIN_ERROR_VISIBLE_MS) {
      current.current = null;
      setErrorMessage(null);
      return;
    }
    clearTimer.current = window.setTimeout(() => {
      clearTimer.current = null;
      current.current = null;
      setErrorMessage(null);
    }, MIN_ERROR_VISIBLE_MS - shownFor);
  }, []);

  useEffect(() => () => {
    if (clearTimer.current !== null) window.clearTimeout(clearTimer.current);
  }, []);

  return { error, setError };
}

/**
 * 세션 색인 한 벌 — 목록 전체를 실제 파일과 맞추는 조정, 실행 한 건이 목록에 나타날
 * 때까지 쫓는 추적, 색인이 언제 기준인지 보는 15초 폴링이다. App 본문에 상태 하나·ref
 * 셋·콜백 둘·폴링 하나·효과 하나로 흩어져 있어 "목록이 왜 아직 옛 것인가"를 보려면
 * 떨어진 여섯 자리를 함께 읽어야 했다. 진행 중 조정·동기화와 재시도 예산은 밖에서
 * 보이지 않아도 되므로 훅 안에서 끝낸다.
 *
 * 포기한 색인 대상(`abandonedSessionSyncs`)만은 반복 일정 한 벌이 함께 보는 것이라
 * ref 그대로 돌려준다.
 */
function useSessionCatalogCenter({ snapshotRef, sessionsViewActive, refresh, reportFailure }: {
  snapshotRef: MutableRefObject<ManagerSnapshot | null>;
  sessionsViewActive: boolean;
  refresh: () => Promise<ManagerSnapshot | null>;
  reportFailure: (cause: unknown) => void;
}) {
  const [catalogHealth, setCatalogHealth] = useState<CatalogHealth | null>(null);
  const sessionCatalogSyncs = useRef(new Map<string, Promise<void>>());
  // 재시도 예산을 다 쓴 색인 대상. 기록을 남기지 못한 실행은 목록에 절대 나타나지
  // 않으므로, 표시해 두지 않으면 폴링마다 같은 요청을 영구히 다시 만든다.
  const abandonedSessionSyncs = useRef(new Set<string>());
  const catalogReconciliation = useRef<Promise<void> | null>(null);

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
  }, [refresh, reportFailure, snapshotRef]);

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
  }, [refresh, reportFailure, snapshotRef]);

  // 갱신이 멈춰도 스냅샷 읽기는 성공하므로, 목록이 언제 기준인지는 이 상태로만 알 수
  // 있다. 배경 주기 갱신이 색인을 올렸는지도 개정 번호로 알아채 화면을 따라가게 한다.
  const pollCatalogHealth = useCallback(async () => {
    const health = await getCatalogHealth();
    setCatalogHealth(keepIfSame(health));
    if (catalogRefreshNeeded(snapshotRef.current, health)) await refresh();
  }, [refresh, snapshotRef]);
  usePoll(pollCatalogHealth, 15_000);

  useEffect(() => {
    if (!sessionsViewActive || !snapshotRef.current) return undefined;
    const timer = window.setTimeout(() => { void reconcileSessionList(); }, 0);
    return () => window.clearTimeout(timer);
  }, [reconcileSessionList, sessionsViewActive, snapshotRef]);

  return { catalogHealth, reconcileSessionList, syncSessionCatalog, abandonedSessionSyncs };
}

/**
 * 앱을 끄기 전에 무엇이 끊기는지 한 번 묻는다.
 *
 * 앱 종료는 백엔드까지 함께 내리고, 백엔드가 내려가면 그 백엔드가 띄운 CLI는 출력을
 * 받아 줄 상대가 없어 살려 둘 이유도 없다. 그래서 종료가 진행 중인 실행을 정리하는 것
 * 자체는 맞지만, 무인 회차가 여럿 도는 중에 Cmd+Q 한 번으로 되돌릴 수 없이 끊기는 것은
 * 다른 문제다. 셸이 사용자의 종료 의사를 그대로 실행하지 않고 여기로 넘기면, 화면은
 * 끊길 것을 세어 보여 주고 사용자의 답을 셸에 돌려준다.
 *
 * 끊길 것이 없으면 묻지 않는다 — 끌 때마다 확인 창이 뜨는 앱이 되면 사람은 창을 읽지
 * 않고 누르게 되고, 정작 무인 회차가 도는 순간에도 그냥 누른다.
 *
 * 물을 근거를 얻지 못했으면(백엔드 응답 실패) 막지 않고 종료한다. 확인 절차가 종료를
 * 가로막는 쪽이 더 나쁘고, 셸도 같은 이유로 답이 없으면 스스로 종료한다.
 */
function useQuitConfirmation(text: (ko: string, en: string) => string) {
  const { confirm, confirmDialog } = useConfirm();

  const askBeforeQuit = useCallback(async () => {
    try {
      const impact = await getShutdownImpact().catch(() => null);
      if (!impact || impact.liveRuntimeCount === 0) {
        await respondToQuit("quit");
        return;
      }
      // 확인 창을 띄웠다고 먼저 알려 셸의 폴백 종료를 멈춘다. 그래야 사용자가 창을
      // 읽는 동안 앱이 스스로 꺼지지 않는다.
      await respondToQuit("prompting");
      const lines = [
        text(
          `실행 중인 대화 ${impact.liveRuntimeCount}개가 정리됩니다.`,
          `${impact.liveRuntimeCount} running conversation(s) will be shut down.`,
        ),
      ];
      if (impact.unattendedCount > 0) {
        lines.push(text(
          `그중 ${impact.unattendedCount}개는 화면에 열려 있지 않은 무인 실행입니다.`,
          `${impact.unattendedCount} of them are unattended runs with no open screen.`,
        ));
      }
      if (impact.activeTurnCount > 0) {
        lines.push(text(
          `응답 중인 턴 ${impact.activeTurnCount}개는 복구되지 않습니다.`,
          `${impact.activeTurnCount} in-flight turn(s) will not be recovered.`,
        ));
      }
      lines.push(text(
        "앱을 다시 열면 대화는 이어서 열 수 있습니다.",
        "You can reopen these conversations after starting the app again.",
      ));
      const accepted = await confirm({
        title: text("종료 확인", "Quit Agent Manager"),
        message: lines.join("\n"),
        confirmLabel: text("종료", "Quit"),
        tone: "danger",
      });
      await respondToQuit(accepted ? "quit" : "cancel");
    } catch {
      // 확인 절차가 실패해도 종료 의사는 남는다. 셸에 마지막으로 한 번 더 알린다.
      await respondToQuit("quit").catch(() => undefined);
    }
  }, [confirm, text]);

  useShellEvent("quit-requested", () => { void askBeforeQuit(); });

  return confirmDialog;
}

/**
 * 반복 일정 한 벌 — 10초 폴링, 트레이 메뉴의 일시정지 토글, 완료된 실행을 세션 목록에
 * 반영하는 색인 추적이다. App 본문에 상태 하나·ref 둘·효과 하나·폴링 하나로 흩어져 있어
 * "방금 누른 토글이 왜 되돌아가는가"를 보려면 떨어진 네 자리를 함께 읽어야 했다. 화면이
 * 쓰는 것은 목록과 세 창구뿐이라 세대 번호와 완료 실행 id 집합은 밖에서 보이지 않아도 된다.
 *
 * 포기한 색인 대상(`abandonedSessionSyncs`)만은 세션 카탈로그 동기화와 공유하는 것이라
 * 훅 안으로 들이지 않고 App이 소유한 채 넘겨받는다.
 */
function useSchedulerCenter({ sessions, syncSessionCatalog, abandonedSessionSyncs, reportFailure }: {
  sessions: SessionSummary[] | undefined;
  syncSessionCatalog: (source: ProviderId, id: string) => Promise<void>;
  abandonedSessionSyncs: MutableRefObject<Set<string>>;
  reportFailure: (cause: unknown) => void;
}) {
  const [schedulerSnapshot, setSchedulerSnapshot] = useState<SchedulerSnapshot | null>(null);
  const completedRunIds = useRef<Set<string> | null>(null);
  // 10초 폴링이 화면에 먼저 올린 토글 상태를 되돌리지 못하게 막는다.
  const schedulerRevision = useRef(0);

  useShellEvent("toggle-scheduler-pause", () => {
    void getSchedulerSnapshot()
      .then((current) => setSchedulesPaused(!current.paused))
      .then(setSchedulerSnapshot)
      .catch(reportFailure);
  });

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
    const known = sessions ?? [];
    // 색인될 수 없는 완료 실행(기록을 남기지 못한 실행)은 포기 목록에서 걸러 낸다.
    // 걸러 내지 않으면 폴링마다 같은 갱신 요청이 다시 생겨 백엔드 대기가 쌓인다.
    const pending = unindexedRunTargets(
      completed,
      sourceByScheduleId,
      (source, id) => known.some((session) => session.source === source && session.id === id),
      abandonedSessionSyncs.current,
    );
    const hasNewCompletion = Boolean(previousIds && completed.some((run) => !previousIds.has(run.id)));
    if (hasNewCompletion || pending.length > 0) {
      await Promise.all(pending.map((target) => syncSessionCatalog(target.source, target.id)));
    }
    // 실패는 전역 오류로 올리지 않는다. usePoll이 그대로 받아 백오프한다.
  }, [abandonedSessionSyncs, sessions, syncSessionCatalog]);
  const refreshScheduler = usePoll(pollScheduler, 10_000);

  // 반복 요청 화면이 스냅샷을 직접 갈아 끼운다. 토글은 화면을 먼저 바꾸고, 서버 응답이
  // 오면 그 값으로 다시 덮는다. 목록 전체를 다시 받지 않으므로 왕복이 한 번으로 줄고,
  // 세대 번호가 올라가 진행 중이던 폴링 응답은 버려진다.
  const applySchedulerSnapshot = useCallback((update: (current: SchedulerSnapshot) => SchedulerSnapshot) => {
    schedulerRevision.current += 1;
    setSchedulerSnapshot((current) => current ? update(current) : current);
  }, []);

  return { schedulerSnapshot, refreshScheduler, applySchedulerSnapshot };
}

/**
 * 알림창(attention) 한 벌 — 목록 폴링, 낙관적 읽음·삭제, 알림 클릭의 화면 라우팅,
 * 세션·AIA·채팅 뷰로 내려보내는 타깃과 그 해제까지를 훅 하나가 통째로 맡는다.
 * App 본문에는 이 훅이 돌려주는 값을 화면에 꽂는 일만 남는다.
 */
/**
 * 사이드바 상태 카드가 보는 계정 사용량 한 벌 — 계정 스냅샷 폴링, 다시 조회할 계정을 고르는
 * 판정, 계정 레지스트리 밖에 있는 Antigravity 별도 폴링, 그리고 셋을 한 번에 다시 읽는 상태
 * 카드 새로고침이다. App 본문에 상태 셋·ref 둘·폴링 두 벌로 흩어져 있어 "언제 다시
 * 조회하는가"를 고치려면 다섯 자리를 함께 읽어야 했다. 화면이 쓰는 것은 값과 새로고침
 * 창구뿐이라 중복 실행을 막는 ref와 초기화 시각 서명은 밖에서 보이지 않아도 된다.
 */
function useAccountUsageCenter({ antigravityDetected, refresh, reportFailure, onAccountsLoaded }: {
  antigravityDetected: boolean;
  refresh: () => Promise<ManagerSnapshot | null>;
  reportFailure: (cause: unknown) => void;
  /** 계정 폴링이 성공했을 때. 연결 상태와 오류 배너는 App이 소유한다. */
  onAccountsLoaded: () => void;
}): {
  accounts: AccountSnapshot | null;
  setAccounts: Dispatch<SetStateAction<AccountSnapshot | null>>;
  antigravityUsage: AccountUsageView | null;
  statusRefreshing: boolean;
  refreshStatusCard: () => Promise<void>;
} {
  const [accounts, setAccounts] = useState<AccountSnapshot | null>(null);
  // Antigravity는 계정 레지스트리에 없어 계정 스냅샷으로 오지 않는다. 사이드바 카드에 함께
  // 세우기 위해 따로 읽고, CLI가 탐지된 기기에서만 두드린다.
  const [antigravityUsage, setAntigravityUsage] = useState<AccountUsageView | null>(null);
  const [statusRefreshing, setStatusRefreshing] = useState(false);
  const bulkUsageRefreshRunning = useRef(false);
  const usageResetSignatureRef = useRef("");

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
      const refreshable = latest.accounts.some((account) => accountUsageDisplayState(account, now).canRefresh)
        || latest.providers.some((provider) => homeUsageCanRefresh(provider.home, now));
      // 사용자가 직접 누른 새로고침이므로 계정별 갱신 주기를 무시한다. 그러지 않으면
      // 방금 조회한 계정이 섞여 있을 때 버튼이 아무 일도 안 한 것처럼 보인다.
      if (refreshable) await runBulkUsageRefresh(true);
    } catch (cause) {
      reportFailure(cause);
    } finally {
      setStatusRefreshing(false);
    }
  }, [pollAntigravityUsage, refresh, reportFailure, runBulkUsageRefresh]);

  const pollAccounts = useCallback(async () => {
    try {
      const next = await getProviderAccounts();
      // 데이터가 같아도 초기화 시각 경과로 표시가 달라지면 새 객체로 교체해 다시 그린다.
      const resetSignature = elapsedResetSignature(next, Date.now());
      const resetSignatureChanged = usageResetSignatureRef.current !== resetSignature;
      usageResetSignatureRef.current = resetSignature;
      setAccounts(keepIfSame(next, resetSignatureChanged));
      refreshStaleAccountUsage(next);
      // 인증 만료는 지나고 나면 재인증 말고 되살릴 길이 없어서, 사흘 창에 들어오는
      // 순간 한 번 알린다. 알렸는지 여부는 알림 쪽이 기기에 남겨 앱을 다시 열어도
      // 이어진다.
      void notifyExpiringCredentials(next.accounts);
      onAccountsLoaded();
    } catch (cause) {
      reportFailure(cause);
      // 폴링 루프가 백오프하도록 실패를 그대로 전달한다.
      throw cause;
    }
  }, [onAccountsLoaded, refreshStaleAccountUsage, reportFailure]);
  usePoll(pollAccounts, 5_000);

  return { accounts, setAccounts, antigravityUsage, statusRefreshing, refreshStatusCard };
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
    // AIA 작업공간과 기본 작업공간은 앱이 쓰는 내부 경로다. 목록에는 보여도 새 작업을 시작할
    // 프로젝트는 아니다 — "작업 경로 없음"은 선택지로 따로 있다.
    if (!path || session.meta.hidden || session.aiaWorkspace || session.defaultWorkspace) continue;
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

export default App;
