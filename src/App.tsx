import { lazy, memo, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import "./App.css";
import type { AiaAttentionTarget, AiaAutoPrompt } from "./components/AiaChatPopup";
import type { ChatViewAttentionTarget } from "./components/ChatView";
import { ChatAttentionCenter } from "./components/ChatAttentionCenter";
import { DashboardView } from "./components/DashboardView";
import { AiaMark, ErrorBanner, LoadingState, LogoMark } from "./components/Shared";
import type { SessionAttentionTarget } from "./components/SessionsView";
import {
  clearReadChatAttention,
  dismissChatAttention,
  getManagerSnapshot,
  getProviderAccounts,
  getChatAttentionSnapshot,
  getSchedulerSnapshot,
  getSystemAutomationSnapshot,
  hasTauriRuntime,
  markChatAttentionRead,
  reconcileSessionCatalog,
  refreshProviderAccountUsage,
  refreshSessionCatalog,
  RemoteConnectionError,
  setSchedulesPaused,
} from "./lib/ipc";
import { selectAiaAttention, withoutAiaAttention } from "./lib/aiaAttention";
import { aiaRuntimeProvider } from "./lib/aiaRuntime";
import { accountUsageDisplayState } from "./lib/accountUsage";
import { useI18n } from "./lib/i18n";
import { applyAccentColor, applyThemeMode, loadAccentColor, loadThemeMode, saveAccentColor, saveThemeMode } from "./lib/theme";
import { notifyAutoSwitchEvents, notifyNewAttention } from "./lib/webNotifications";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Bot, FileText, HardDrive, LayoutDashboard, Layers, MessagesSquare, Puzzle, Settings, Sparkles, type LucideIcon } from "lucide-react";
import type { AccountSnapshot, AccentColor, ChatAttentionItem, ChatAttentionSnapshot, ManagerSnapshot, MessageDisplayMode, ModelOption, ProjectOption, ProviderId, ProviderStatus, SchedulerSnapshot, SessionFolder, SessionMeta, SessionSummary, SystemAutomationSnapshot, ThemeMode, TranslationStatus, ViewId } from "./types";

const MESSAGE_DISPLAY_MODE_KEY = "agent-manager.message-display-mode.v1";
const EMPTY_CHAT_ATTENTION: ChatAttentionSnapshot = { items: [], unreadCount: 0, pendingCount: 0 };
/**
 * 시스템 에이전트를 고르지 않아 AIA가 꺼져 있을 때 트리거에 띄우는 안내. 브라우저는
 * `disabled` 버튼에 title 툴팁을 띄우지 않으므로, 트리거는 `aria-disabled`로 표시하고
 * 클릭만 막아 마우스 오버 안내를 유지한다.
 */
const AIA_DISABLED_HINT = "시스템 에이전트가 설정되지 않았습니다. 설정에서 시스템 에이전트를 선택하세요.";

// 폴링 응답 내용이 같으면 기존 state 참조를 유지해, 마운트된(숨겨진) 뷰 전체가 매 폴링마다 재조정되는 것을 막는다.
function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
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
const MemoChatView = lazy(() => import("./components/ChatView").then((module) => ({ default: memo(module.ChatView) })));
const MemoSessionsView = lazy(() => import("./components/SessionsView").then((module) => ({ default: memo(module.SessionsView) })));
const MemoDocsView = lazy(() => import("./components/DocsView").then((module) => ({ default: memo(module.DocsView) })));
const MemoSkillsView = lazy(() => import("./components/SkillsView").then((module) => ({ default: memo(module.SkillsView) })));
const MemoAgentsView = lazy(() => import("./components/AgentsView").then((module) => ({ default: memo(module.AgentsView) })));
const MemoArtifactsView = lazy(() => import("./components/ArtifactsView").then((module) => ({ default: memo(module.ArtifactsView) })));
const MemoStorageView = lazy(() => import("./components/StorageView").then((module) => ({ default: memo(module.StorageView) })));
const MemoSettingsView = lazy(() => import("./components/SettingsView").then((module) => ({ default: memo(module.SettingsView) })));
const AiaChatPopup = lazy(() => import("./components/AiaChatPopup").then((module) => ({ default: module.AiaChatPopup })));
const CliConnectionDrawer = lazy(() => import("./components/CliConnectionDrawer").then((module) => ({ default: module.CliConnectionDrawer })));

const navigation: { id: ViewId; icon: LucideIcon }[] = [
  { id: "dashboard", icon: LayoutDashboard },
  { id: "chat", icon: Sparkles },
  { id: "sessions", icon: MessagesSquare },
  { id: "docs", icon: FileText },
  { id: "skills", icon: Puzzle },
  { id: "agents", icon: Bot },
  { id: "artifacts", icon: Layers },
  { id: "storage", icon: HardDrive },
  { id: "settings", icon: Settings },
];

function App() {
  const { locale, setLocale, text } = useI18n();
  const [snapshot, setSnapshot] = useState<ManagerSnapshot | null>(null);
  const [automation, setAutomation] = useState<SystemAutomationSnapshot | null>(null);
  const [accounts, setAccounts] = useState<AccountSnapshot | null>(null);
  const [schedulerSnapshot, setSchedulerSnapshot] = useState<SchedulerSnapshot | null>(null);
  const [scheduleFocusRequest, setScheduleFocusRequest] = useState(0);
  const [view, setView] = useState<ViewId>("dashboard");
  const [mountedViews, setMountedViews] = useState<Set<ViewId>>(() => new Set(["dashboard"]));
  const [messageDisplayMode, setMessageDisplayMode] = useState<MessageDisplayMode>(loadMessageDisplayMode);
  const [themeMode, setThemeMode] = useState<ThemeMode>(loadThemeMode);
  const [accentColor, setAccentColor] = useState<AccentColor>(loadAccentColor);
  const [selectedSession, setSelectedSession] = useState<SessionSummary | null>(null);
  const [chatAttention, setChatAttention] = useState<ChatAttentionSnapshot>(EMPTY_CHAT_ATTENTION);
  const [aiaAttentionTarget, setAiaAttentionTarget] = useState<AiaAttentionTarget | null>(null);
  const [chatViewAttentionTarget, setChatViewAttentionTarget] = useState<ChatViewAttentionTarget | null>(null);
  const [sessionAttentionTarget, setSessionAttentionTarget] = useState<SessionAttentionTarget | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const [setupProviderId, setSetupProviderId] = useState<ProviderId | null>(null);
  const [aiaOpen, setAiaOpen] = useState(false);
  const [aiaMounted, setAiaMounted] = useState(false);
  const [aiaAutoPrompt, setAiaAutoPrompt] = useState<AiaAutoPrompt | null>(null);
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
  const catalogReconciliation = useRef<Promise<void> | null>(null);
  const attentionRequestId = useRef(0);
  const handledAttentionRequests = useRef(new Set<number>());
  const usageRefreshes = useRef(new Set<string>());
  const wasReconnecting = useRef(false);

  // 웹 모드에서 원격 서버에 닿지 못한 실패는 오류 배너 대신 재연결 상태로 표시한다.
  const reportFailure = useCallback((cause: unknown) => {
    if (cause instanceof RemoteConnectionError) {
      setReconnecting(true);
      if (!snapshotRef.current) setError(cause.message);
      return;
    }
    setError(cause instanceof Error ? cause.message : String(cause));
  }, []);

  const refresh = useCallback(async (propagateError = false) => {
    setError(null);
    try {
      const next = await getManagerSnapshot();
      snapshotRef.current = next;
      setSnapshot(next);
      setReconnecting(false);
      setSelectedSession((selected) => selected ? next.sessions.find((session) => session.source === selected.source && session.id === selected.id) ?? null : null);
      return next;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (cause instanceof RemoteConnectionError) {
        setReconnecting(true);
        if (!snapshotRef.current) setError(message);
      } else setError(message);
      if (propagateError) throw new Error(message);
      return null;
    }
  }, []);

  const reconcileSessionList = useCallback(() => {
    if (catalogReconciliation.current) return catalogReconciliation.current;
    const task = (async () => {
      try {
        const update = await reconcileSessionCatalog();
        if (snapshotRef.current?.sessionCatalogRevision !== update.revision) {
          await refresh();
        }
      } catch (cause) {
        reportFailure(cause);
      }
    })().finally(() => {
      catalogReconciliation.current = null;
    });
    catalogReconciliation.current = task;
    return task;
  }, [refresh, reportFailure]);

  const syncSessionCatalog = useCallback((source: ProviderId, id: string) => {
    const key = `${source}\u0000${id}`;
    const activeSync = sessionCatalogSyncs.current.get(key);
    if (activeSync) return activeSync;
    const sync = (async () => {
      let lastError: unknown = null;
      for (const delay of [0, 200, 600, 1_200, 2_400]) {
        if (delay > 0) await new Promise((resolve) => window.setTimeout(resolve, delay));
        try {
          const update = await refreshSessionCatalog(source, id);
          const next = snapshotRef.current?.sessionCatalogRevision === update.revision
            ? snapshotRef.current
            : await refresh();
          if (next?.sessions.some((session) => session.source === source && session.id === id)) return;
        } catch (cause) {
          lastError = cause;
        }
      }
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

  // AIA의 세션 상태는 첫 사용 뒤 계속 보존하되, 사용 전에는 큰 채팅 번들을 내려받지 않는다.
  useEffect(() => {
    if (aiaOpen) setAiaMounted(true);
  }, [aiaOpen]);

  // 연결이 복구되면 끊긴 사이의 변경을 다시 읽고, 남아 있던 일시 오류 배너도 함께 정리한다.
  useEffect(() => {
    if (wasReconnecting.current && !reconnecting) void refresh();
    wasReconnecting.current = reconnecting;
  }, [reconnecting, refresh]);

  // 폴링 주기마다 실행되므로 accounts state 변화에 의존하지 않고 최신 응답으로 직접 검사한다.
  const refreshStaleAccountUsage = useCallback((current: AccountSnapshot) => {
    const staleBefore = Date.now() - 5 * 60_000;
    for (const account of current.accounts) {
      const providerState = current.providers.find((provider) => provider.provider === account.provider);
      if (!accountUsageDisplayState(account, providerState?.observedActiveAccountId ?? null).canRefresh
        || (account.usage.updatedAt ?? 0) > staleBefore
        || (account.usage.retryAt ?? 0) > Date.now()
        || usageRefreshes.current.has(account.id)) continue;
      usageRefreshes.current.add(account.id);
      void refreshProviderAccountUsage(account.id)
        .then((updated) => setAccounts((previous) => previous && sameJson(previous, updated) ? previous : updated))
        .catch(() => undefined)
        .finally(() => usageRefreshes.current.delete(account.id));
    }
  }, []);

  useEffect(() => {
    let active = true;
    const poll = async () => {
      try {
        const next = await getProviderAccounts();
        if (!active) return;
        setAccounts((current) => current && sameJson(current, next) ? current : next);
        refreshStaleAccountUsage(next);
        setReconnecting(false);
        if (snapshotRef.current) setError(null);
      } catch (cause) {
        if (active) reportFailure(cause);
      }
    };
    void poll();
    const timer = window.setInterval(() => { void poll(); }, 5_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [refreshStaleAccountUsage, reportFailure]);

  // 계정 스냅샷이 갱신될 때마다(폴링·사용량 갱신·설정 변경) 새 자동전환 이력을 알림으로 표출한다.
  useEffect(() => {
    if (accounts) void notifyAutoSwitchEvents(accounts);
  }, [accounts]);

  useEffect(() => {
    let active = true;
    const poll = async () => {
      try {
        const next = await getSystemAutomationSnapshot();
        if (!active) return;
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
        if (!active) return;
        if (cause instanceof RemoteConnectionError) {
          setReconnecting(true);
        } else if (!automationRef.current) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      }
    };
    void poll();
    const timer = window.setInterval(() => { void poll(); }, 3_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [refresh, setLocale]);

  useEffect(() => {
    try { window.localStorage.setItem(MESSAGE_DISPLAY_MODE_KEY, messageDisplayMode); }
    catch { /* The selected behavior still applies for the current app run. */ }
  }, [messageDisplayMode]);

  useEffect(() => {
    saveThemeMode(themeMode);
    applyThemeMode(themeMode);
    if (hasTauriRuntime()) {
      // 창 크롬(타이틀바)도 콘텐츠 테마와 맞춘다. auto는 OS 설정을 따르도록 되돌린다.
      void getCurrentWindow().setTheme(themeMode === "auto" ? null : themeMode).catch(() => undefined);
    }
  }, [themeMode]);

  useEffect(() => {
    saveAccentColor(accentColor);
    applyAccentColor(accentColor);
  }, [accentColor]);

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

  useEffect(() => {
    let active = true;
    const pollScheduler = async () => {
      try {
        const scheduler = await getSchedulerSnapshot();
        if (active) setSchedulerSnapshot((current) => current && sameJson(current, scheduler) ? current : scheduler);
        const completed = scheduler.runs.filter((run) => run.status === "completed" && run.providerSessionId);
        const nextIds = new Set(completed.map((run) => run.id));
        const previousIds = completedRunIds.current;
        completedRunIds.current = nextIds;
        const sourceByScheduleId = new Map(scheduler.schedules.map((schedule) => [schedule.id, schedule.source]));
        const hasUnindexedResult = completed.some((run) => {
          const source = sourceByScheduleId.get(run.scheduleId);
          return source && !snapshot?.sessions.some((session) => session.source === source && session.id === run.providerSessionId);
        });
        const hasNewCompletion = Boolean(previousIds && completed.some((run) => !previousIds.has(run.id)));
        if (active && (hasNewCompletion || hasUnindexedResult)) {
          await Promise.all(completed.map((run) => {
            const source = sourceByScheduleId.get(run.scheduleId);
            return source && run.providerSessionId
              ? syncSessionCatalog(source, run.providerSessionId)
              : Promise.resolve();
          }));
        }
      } catch {
        // The next poll retries transient remote adapter failures without surfacing a global error.
      }
    };
    void pollScheduler();
    const timer = window.setInterval(() => { void pollScheduler(); }, 10_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [snapshot?.sessions, syncSessionCatalog]);

  useEffect(() => {
    let active = true;
    const pollAttention = async () => {
      try {
        const next = await getChatAttentionSnapshot();
        if (active) {
          setChatAttention((current) => sameJson(current, next) ? current : next);
          // AIA는 일반 인앱 알림창에서만 분리한다. 기기 알림은 모든 프로필을 알려야 한다.
          void notifyNewAttention(next.items, snapshotRef.current?.sessions ?? []);
        }
      } catch {
        // Temporary remote or IPC failures are retried without replacing the current notification list.
      }
    };
    void pollAttention();
    const timer = window.setInterval(() => { void pollAttention(); }, 2_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (view !== "sessions" || !snapshotRef.current) return undefined;
    const timer = window.setTimeout(() => { void reconcileSessionList(); }, 0);
    return () => window.clearTimeout(timer);
  }, [reconcileSessionList, view]);

  // 사이드바 CLI 상태 버튼은 설정의 CLI 연결 중메뉴로 바로 보낸다. 설정 화면은
  // 마운트된 채 유지되므로 요청 횟수를 올려 탭 전환을 알린다.
  const [settingsConnectionsRequest, setSettingsConnectionsRequest] = useState(0);
  const projectOptions = useMemo(() => collectProjects(snapshot?.sessions ?? []), [snapshot?.sessions]);
  const modelOptions = useMemo(() => collectModels(snapshot?.sessions ?? []), [snapshot?.sessions]);

  const activateView = useCallback((nextView: ViewId) => {
    setMountedViews((current) => {
      if (current.has(nextView)) return current;
      const next = new Set(current);
      next.add(nextView);
      return next;
    });
    setView(nextView);
  }, []);

  const markAllAttentionRead = useCallback(() => {
    const ids = chatAttention.items
      .filter((item) => item.profile !== "aia" && item.kind !== "approval" && !item.read)
      .map((item) => item.id);
    void (async () => {
      let next = chatAttention;
      for (const id of ids) next = await markChatAttentionRead(id);
      setChatAttention(next);
    })().catch(() => undefined);
  }, [chatAttention]);

  const clearReadAttention = useCallback(() => {
    void clearReadChatAttention()
      .then(setChatAttention)
      .catch(() => undefined);
  }, []);

  const dismissAttention = useCallback(async (item: ChatAttentionItem) => {
    try {
      setChatAttention(await dismissChatAttention(item.id));
      return true;
    } catch {
      return false;
    }
  }, []);

  const openAttentionItem = useCallback((item: ChatAttentionItem) => {
    if (item.profile === "aia") {
      attentionRequestId.current += 1;
      setAiaAttentionTarget({
        chatId: item.chatId,
        attentionId: item.id,
        markRead: item.kind !== "approval",
        requestId: attentionRequestId.current,
      });
      setAiaOpen(true);
      return;
    }
    const openAttachedChat = () => {
      attentionRequestId.current += 1;
      setChatViewAttentionTarget({
        chatId: item.chatId,
        attentionId: item.id,
        markRead: item.kind !== "approval",
        requestId: attentionRequestId.current,
      });
      activateView("chat");
    };
    if (item.unattended) {
      void (async () => {
        const sessionId = item.providerSessionId;
        let session = sessionId
          ? snapshotRef.current?.sessions.find((candidate) => candidate.source === item.source && candidate.id === sessionId)
          : undefined;
        if (sessionId && !session) {
          await syncSessionCatalog(item.source, sessionId);
          session = snapshotRef.current?.sessions.find((candidate) => candidate.source === item.source && candidate.id === sessionId);
        }
        setSessionAttentionTarget(null);
        setSelectedSession(session ?? null);
        activateView("sessions");
        if (!session) {
          setError("예약 실행 세션이 아직 세션 목록에 반영되지 않았습니다.");
          return;
        }
        setError(null);
        if (item.kind !== "approval") {
          const next = await markChatAttentionRead(item.id);
          setChatAttention(next);
        }
      })().catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      });
      return;
    }
    if (!item.resuming) {
      openAttachedChat();
      return;
    }
    const sessionId = item.providerSessionId;
    if (!sessionId) {
      openAttachedChat();
      return;
    }
    void (async () => {
      let session = snapshotRef.current?.sessions.find((candidate) => candidate.source === item.source && candidate.id === sessionId);
      if (!session) {
        await syncSessionCatalog(item.source, sessionId);
        session = snapshotRef.current?.sessions.find((candidate) => candidate.source === item.source && candidate.id === sessionId);
      }
      if (!session) {
        openAttachedChat();
        return;
      }
      setSelectedSession(session);
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
      setError(cause instanceof Error ? cause.message : String(cause));
    });
  }, [activateView, syncSessionCatalog]);

  // AIA는 시스템 설정에서 고른 시스템 에이전트로 실행된다. 고르지 않으면 AIA 기능
  // 전체(트리거·팝업·자동 요청·알림)가 꺼진다. 선택값은 백엔드에 영속되므로 새로고침
  // 뒤에도 자동화 스냅샷 폴링으로 그대로 복원된다.
  const aiaProviderId = aiaRuntimeProvider(automation);
  // AIA가 꺼져 있으면 열 수 있는 대화가 없으므로 남은 알림도 트리거에 표시하지 않는다.
  const aiaAttention = aiaProviderId ? selectAiaAttention(chatAttention.items) : null;
  const visibleChatAttention = withoutAiaAttention(chatAttention);
  const toggleAia = useCallback(() => {
    if (aiaAttention) {
      openAttentionItem(aiaAttention);
      return;
    }
    setAiaOpen((current) => !current);
  }, [aiaAttention, openAttentionItem]);

  const selectSession = useCallback((session: SessionSummary | null) => {
    setSessionAttentionTarget(null);
    setSelectedSession(session);
  }, []);

  const clearSessionAttentionTarget = useCallback((target: SessionAttentionTarget, opened: boolean) => {
    if (handledAttentionRequests.current.has(target.requestId)) return;
    handledAttentionRequests.current.add(target.requestId);
    setSessionAttentionTarget((current) => current?.requestId === target.requestId ? null : current);
    if (opened && target.markRead) {
      void markChatAttentionRead(target.attentionId)
        .then(setChatAttention)
        .catch(() => undefined);
    }
  }, []);

  const clearAiaAttentionTarget = useCallback((target: AiaAttentionTarget, opened: boolean) => {
    if (handledAttentionRequests.current.has(target.requestId)) return;
    handledAttentionRequests.current.add(target.requestId);
    setAiaAttentionTarget((current) => current?.requestId === target.requestId ? null : current);
    if (opened && target.markRead) {
      void markChatAttentionRead(target.attentionId)
        .then(setChatAttention)
        .catch(() => undefined);
    }
  }, []);

  const clearChatViewAttentionTarget = useCallback((target: ChatViewAttentionTarget, opened: boolean) => {
    if (handledAttentionRequests.current.has(target.requestId)) return;
    handledAttentionRequests.current.add(target.requestId);
    setChatViewAttentionTarget((current) => current?.requestId === target.requestId ? null : current);
    if (opened && target.markRead) {
      void markChatAttentionRead(target.attentionId)
        .then(setChatAttention)
        .catch(() => undefined);
    }
  }, []);

  const openSession = useCallback((session: SessionSummary) => {
    selectSession(session);
    activateView("sessions");
  }, [selectSession, activateView]);

  // 대시보드 '반복 일정' 패널에서 채팅 뷰의 반복 요청 탭으로 바로 이동한다.
  const openSchedules = useCallback(() => {
    setScheduleFocusRequest((current) => current + 1);
    activateView("chat");
  }, [activateView]);

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
      const folders = recountFolders(current.folders, sessions);
      return { ...current, sessions, folders, dashboard: { ...current.dashboard, recent } };
    });
    setSelectedSession((current) => current && current.source === source && current.id === id ? { ...current, title: meta.customTitle ?? current.sourceTitle ?? current.title, meta } : current);
  }, []);

  const updateFolders = useCallback((folders: SessionFolder[], deletedFolderId?: string) => {
    setSnapshot((current) => {
      if (!current) return current;
      const sessions = deletedFolderId
        ? current.sessions.map((session) => ({
            ...session,
            meta: {
              ...session.meta,
              folderIds: session.meta.folderIds.filter((id) => id !== deletedFolderId),
            },
          }))
        : current.sessions;
      return { ...current, sessions, folders: recountFolders(folders, sessions) };
    });
    if (deletedFolderId) {
      setSelectedSession((current) => current ? {
        ...current,
        meta: {
          ...current.meta,
          folderIds: current.meta.folderIds.filter((id) => id !== deletedFolderId),
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

  const title = navigationLabel(view, locale, text);
  const readyProviders = snapshot.status.providers.filter((provider) => provider.cli.detected).length;
  const setupProvider = setupProviderId
    ? snapshot.status.providers.find((provider) => provider.provider === setupProviderId) ?? null
    : null;
  const aiaProvider = aiaProviderId
    ? snapshot.status.providers.find((provider) => provider.provider === aiaProviderId) ?? null
    : null;
  const activeUsage = accounts?.providers.flatMap((provider) => {
    const activeAccountId = provider.observedActiveAccountId ?? provider.activeAccountId;
    const account = accounts.accounts.find((candidate) => candidate.id === activeAccountId);
    return account ? [account] : [];
  }) ?? [];
  const accountUsageMeters = activeUsage.map((account) => {
    const providerName = snapshot.status.providers.find((provider) => provider.provider === account.provider)?.displayName
      ?? account.provider;
    const windows = account.usage.windows.map((window) => ({
      label: window.label,
      percent: Math.min(100, Math.max(0, window.usedPercent)),
    }));
    return { account, providerName, windows };
  });
  const maxUsage = accountUsageMeters.reduce<number | null>(
    (maximum, meter) => meter.windows.reduce<number | null>(
      (innerMaximum, window) => Math.max(innerMaximum ?? window.percent, window.percent),
      maximum,
    ),
    null,
  );
  const nearestReset = activeUsage.flatMap((account) => account.usage.windows)
    .map((window) => window.resetsAt)
    .filter((value): value is number => value !== null && value > Date.now())
    .sort((left, right) => left - right)[0] ?? null;
  const usageError = activeUsage.some((account) => account.isActive && account.usage.status === "error");

  return (
    <div className={`manager-shell${aiaOpen && aiaProviderId ? " aia-open" : ""}`}>
      <aside className="app-sidebar">
        <div className="brand"><LogoMark size={37} /><div><strong>Agent Manager</strong><span>LOCAL CONTROL PLANE</span></div></div>
        <nav aria-label={text("주 메뉴", "Main menu")}>
          {navigation.map((item) => (
            <button className={view === item.id ? "active" : ""} type="button" key={item.id} onClick={() => activateView(item.id)}>
              <span><item.icon size={16} strokeWidth={1.8} aria-hidden="true" /></span>{navigationLabel(item.id, locale, text)}
              {item.id === "sessions" && <em>{snapshot.dashboard.sessionCount}</em>}
            </button>
          ))}
        </nav>
        <button className="sidebar-status" type="button" onClick={() => { setSettingsConnectionsRequest((count) => count + 1); activateView("settings"); }} title={text("CLI 연결 상태 열기", "Open CLI connection status")}>
          <span className={`pulse-dot${usageError ? " warning" : ""}`} />
          <div className="sidebar-status-copy">
            <strong>{readyProviders}/3 {text("CLI 연결", "CLIs connected")}{maxUsage === null ? "" : ` · ${Math.round(maxUsage)}%`}</strong>
            {accountUsageMeters.length > 0 && <div className="sidebar-account-usages" aria-label={text("활성 계정별 사용량", "Usage by active account")}>
              {accountUsageMeters.map(({ account, providerName, windows }) => {
                const accountLabel = `${providerName} · ${account.displayName}`;
                const usageLabel = windows.length === 0
                  ? `${accountLabel} · ${text("사용량 정보 없음", "Usage unavailable")}`
                  : `${accountLabel} · ${windows.map((window) => `${window.label} ${Math.round(window.percent)}%`).join(" · ")}`;
                return <div className="sidebar-account-usage" key={account.id} title={usageLabel}>
                  <span className="sidebar-account-usage-label">{accountLabel}</span>
                  {windows.length === 0
                    ? <div className="sidebar-account-usage-window unavailable">
                        <span className="sidebar-account-window-label">{text("사용량 정보 없음", "Usage unavailable")}</span>
                        <span className="sidebar-account-usage-value">{account.usage.status === "error" ? text("오류", "Error") : "—"}</span>
                        <span
                          className="sidebar-account-progress"
                          role="progressbar"
                          aria-label={usageLabel}
                          aria-valuemin={0}
                          aria-valuemax={100}
                        ><span style={{ width: "0%" }} /></span>
                      </div>
                    : windows.map((window) => {
                        const valueLabel = `${Math.round(window.percent)}%`;
                        const windowLabel = `${accountLabel} · ${window.label} ${valueLabel}`;
                        return <div className={`sidebar-account-usage-window${window.percent >= 90 ? " critical" : window.percent >= 70 ? " warning" : ""}`} key={window.label}>
                          <span className="sidebar-account-window-label">{window.label}</span>
                          <span className="sidebar-account-usage-value">{valueLabel}</span>
                          <span
                            className="sidebar-account-progress"
                            role="progressbar"
                            aria-label={windowLabel}
                            aria-valuemin={0}
                            aria-valuemax={100}
                            aria-valuenow={Math.round(window.percent)}
                          ><span style={{ width: `${window.percent}%` }} /></span>
                        </div>;
                      })}
                </div>;
              })}
            </div>}
            <span className="sidebar-status-detail">{usageError ? text("사용량 확인 오류", "Usage check failed") : nearestReset ? `${new Date(nearestReset).toLocaleString()} ${text("초기화", "reset")}` : `${snapshot.status.platform} · ${snapshot.status.architecture}`}</span>
          </div>
        </button>
      </aside>

      <section className="app-content">
        <header className="topbar">
          <h1>{title}</h1>
          <div className="topbar-actions">
            <button
              className={`aia-trigger${aiaOpen && aiaProviderId ? " active" : ""}${aiaAttention ? " attention" : ""}${aiaProviderId ? "" : " disabled"}`}
              type="button"
              aria-disabled={!aiaProviderId}
              aria-label={!aiaProviderId ? AIA_DISABLED_HINT : aiaAttention ? "AIA에 확인할 내용이 있습니다" : "AIA 열기"}
              aria-pressed={aiaOpen && Boolean(aiaProviderId)}
              onClick={() => { if (aiaProviderId) toggleAia(); }}
              title={!aiaProviderId
                ? AIA_DISABLED_HINT
                : aiaAttention?.kind === "approval" ? "AIA 권한 승인이 필요합니다" : aiaAttention ? "AIA 답변을 확인하세요" : "AIA 열기"}
            ><AiaMark size={16} /><span className="aia-trigger-name">AIA</span>{aiaAttention && <span className="aia-attention-label" aria-hidden="true">...</span>}</button>
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
          {mountedViews.has("dashboard") && <ViewPanel id="dashboard" activeView={view} key="dashboard"><MemoDashboardView snapshot={snapshot} scheduler={schedulerSnapshot} onOpenSession={openSession} onOpenSchedules={openSchedules} onConnectCli={connectCli} /></ViewPanel>}
          {mountedViews.has("chat") && <ViewPanel id="chat" activeView={view} key="chat"><MemoChatView providers={snapshot.status.providers} accounts={accounts} projects={projectOptions} models={modelOptions} sessions={snapshot.sessions} autoShowNewMessages={messageDisplayMode === "latest"} scheduleFocusRequest={scheduleFocusRequest} onConnectCli={connectCli} onOpenSession={openSession} onSessionCatalogChanged={syncSessionCatalog} attentionTarget={chatViewAttentionTarget} onAttentionTargetHandled={clearChatViewAttentionTarget} /></ViewPanel>}
          {mountedViews.has("sessions") && <ViewPanel id="sessions" activeView={view} key="sessions"><MemoSessionsView sessions={snapshot.sessions} folders={snapshot.folders} selected={selectedSession} openAtLatest={messageDisplayMode === "latest"} onSelect={selectSession} onMetaChanged={updateSessionMeta} onFoldersChanged={updateFolders} attentionTarget={sessionAttentionTarget} onAttentionTargetHandled={clearSessionAttentionTarget} /></ViewPanel>}
          {mountedViews.has("docs") && <ViewPanel id="docs" activeView={view} key="docs"><MemoDocsView /></ViewPanel>}
          {mountedViews.has("skills") && <ViewPanel id="skills" activeView={view} key="skills"><MemoSkillsView skills={snapshot.skills} automation={automation} onAutomationChange={setAutomation} /></ViewPanel>}
          {mountedViews.has("agents") && <ViewPanel id="agents" activeView={view} key="agents"><MemoAgentsView agents={snapshot.agents} automation={automation} onAutomationChange={setAutomation} /></ViewPanel>}
          {mountedViews.has("artifacts") && <ViewPanel id="artifacts" activeView={view} key="artifacts"><MemoArtifactsView groups={snapshot.artifacts} automation={automation} onAutomationChange={setAutomation} /></ViewPanel>}
          {mountedViews.has("storage") && <ViewPanel id="storage" activeView={view} key="storage"><MemoStorageView /></ViewPanel>}
          {mountedViews.has("settings") && <ViewPanel id="settings" activeView={view} key="settings"><MemoSettingsView active={view === "settings"} providers={snapshot.status.providers} accounts={accounts} onAccountsChange={setAccounts} onConnectCli={connectCli} themeMode={themeMode} onThemeModeChange={setThemeMode} accentColor={accentColor} onAccentColorChange={setAccentColor} messageDisplayMode={messageDisplayMode} onMessageDisplayModeChange={setMessageDisplayMode} automation={automation} onAutomationChange={applyAutomationChange} onRequestAiaPrompt={requestAiaPrompt} connectionsRequest={settingsConnectionsRequest} /></ViewPanel>}
          </Suspense>
        </main>
      </section>
      {setupProvider && <Suspense fallback={null}><CliConnectionDrawer
        provider={setupProvider}
        onClose={() => setSetupProviderId(null)}
        onRefresh={async () => { await refresh(true); }}
        onOpenChat={() => { setSetupProviderId(null); activateView("chat"); }}
      /></Suspense>}
      {aiaMounted && aiaProviderId && <Suspense fallback={null}><AiaChatPopup
        open={aiaOpen}
        provider={aiaProviderId}
        providerName={aiaProvider?.displayName ?? aiaProviderId}
        providerConnected={Boolean(aiaProvider?.cli.detected)}
        attentionTarget={aiaAttentionTarget}
        autoPrompt={aiaAutoPrompt}
        onClose={() => setAiaOpen(false)}
        onAttentionTargetHandled={clearAiaAttentionTarget}
        onAutoPromptHandled={() => setAiaAutoPrompt(null)}
        onConnectProvider={() => {
          setAiaOpen(false);
          if (aiaProvider) setSetupProviderId(aiaProvider.provider);
        }}
      /></Suspense>}
    </div>
  );
}

function ViewPanel({ id, activeView, children }: { id: ViewId; activeView: ViewId; children: ReactNode }) {
  return <section className={id === "docs" ? "view-panel docs-content" : "view-panel"} hidden={id !== activeView}>{children}</section>;
}

function collectProjects(sessions: SessionSummary[]): ProjectOption[] {
  const projects = new Map<string, ProjectOption>();
  for (const session of sessions) {
    const path = session.cwd;
    if (!path || session.meta.hidden) continue;
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

function collectModels(sessions: SessionSummary[]): ModelOption[] {
  const models = new Map<string, ModelOption>();
  for (const session of sessions) {
    const model = session.model;
    if (!model || session.meta.hidden) continue;
    const key = `${session.source}\u0000${model}`;
    const updatedAt = session.updatedAt ?? 0;
    const known = models.get(key);
    if (known) {
      known.count += 1;
      if (updatedAt > known.updatedAt) known.updatedAt = updatedAt;
      continue;
    }
    models.set(key, { source: session.source, model, count: 1, updatedAt });
  }
  return [...models.values()].sort((left, right) => right.updatedAt - left.updatedAt || right.count - left.count);
}

function loadMessageDisplayMode(): MessageDisplayMode {
  try {
    const stored = window.localStorage.getItem(MESSAGE_DISPLAY_MODE_KEY);
    // "fixed"는 이전 버전에서 저장된 값으로, 시작 위치 유지 동작에 해당한다.
    return stored === "start" || stored === "fixed" ? "start" : "latest";
  } catch {
    return "latest";
  }
}

function navigationLabel(view: ViewId, locale: string, translate: (ko: string, en: string) => string): string {
  const labels: Record<ViewId, [string, string]> = {
    dashboard: ["대시보드", "Dashboard"], chat: ["채팅", "Chat"], sessions: ["세션", "Sessions"],
    docs: ["문서", "Documents"], skills: ["스킬", "Skills"], agents: ["에이전트", "Agents"],
    artifacts: ["아티팩트", "Artifacts"], storage: ["저장소", "Storage"], settings: ["설정", "Settings"],
  };
  const [ko, en] = labels[view];
  return locale === "ko" ? ko : translate(ko, en);
}

function recountFolders(folders: SessionFolder[], sessions: SessionSummary[]): SessionFolder[] {
  const counts = new Map<string, number>();
  for (const session of sessions) {
    for (const folderId of session.meta.folderIds) {
      counts.set(folderId, (counts.get(folderId) ?? 0) + 1);
    }
  }
  return folders.map((folder) => ({ ...folder, sessionCount: counts.get(folder.id) ?? 0 }));
}

export default App;
