/**
 * 인앱·기기 알림 한 벌. 알림 목록을 폴링해 들고, 읽음·삭제를 화면 먼저 반영해 보내고,
 * 알림 하나를 눌렀을 때 어느 화면으로 갈지 정한다.
 *
 * App에 함께 있던 것을 떼어냈다. 이 센터가 App에 요구하는 것은 화면 전환·세션 선택·오류
 * 보고 같은 창구 몇 개뿐이라, 붙어 있어야 할 이유가 없었다. 셸이 들고 있으면 알림 경로를
 * 고치는 일마다 1,500줄짜리 파일을 열게 되고, 그 파일은 화면 조립까지 함께 바뀌는 자리다.
 */
import { useCallback, useEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";

import { keepIfSame } from "./appStateIdentity";
import type { AiaAttentionTarget } from "./components/AiaChatPopup";
import type { ChatViewAttentionTarget } from "./components/ChatView";
import type { SessionAttentionTarget } from "./components/SessionsView";
import type { SettingsTabId } from "./components/SettingsView";
import type { WorkflowsTabId } from "./components/WorkflowsView";
import { adoptFoundSession, resolveAttentionRoute } from "./lib/attentionRoute";
import {
  clearReadAttentionLocally,
  dismissAttentionLocally,
  markAllAttentionReadLocally,
  markAttentionReadLocally,
} from "./lib/chatAttention";
import type { AppToastRequest } from "./components/AppToasts";
import { errorText } from "./lib/errorText";
import { runtimeText } from "./lib/i18nRuntime";
import {
  clearReadChatAttention,
  dismissChatAttention,
  getChatAttentionSnapshot,
  getDetachedChatForSession,
  getSessionSummary,
  markAllChatAttentionRead,
  markChatAttentionRead,
} from "./lib/ipc";
import { findNotificationOpenItem, parseNotificationOpenMessage, parseNotificationOpenSearch, stripNotificationOpenSearch, type NotificationOpenTarget } from "./lib/notificationOpen";
import { usePoll } from "./lib/poll";
import type { PopoutRequest } from "./lib/popout";
import { notifyNewAttention } from "./lib/webNotifications";
import type { ChatAttentionItem, ChatAttentionSnapshot, ManagerSnapshot, ProviderId, SessionSummary, ViewId } from "./types";

const EMPTY_CHAT_ATTENTION: ChatAttentionSnapshot = { items: [], unreadCount: 0, pendingCount: 0 };

/** 세션·AIA·채팅 뷰 알림 타깃이 공통으로 갖는, 생성과 해제 판단에 쓰이는 필드. */
interface AttentionTarget {
  chatId: string;
  attentionId: string;
  markRead: boolean;
  requestId: number;
}

export function useChatAttentionCenter({ popoutRequest, snapshotRef, activateView, requestSettingsTab, requestWorkflowsTab, syncSessionCatalog, setSelectedSession, setError, notify, openAia }: {
  popoutRequest: PopoutRequest | null;
  snapshotRef: MutableRefObject<ManagerSnapshot | null>;
  activateView: (view: ViewId) => void;
  requestSettingsTab: (tab: SettingsTabId) => void;
  requestWorkflowsTab: (tab: WorkflowsTabId) => void;
  syncSessionCatalog: (source: ProviderId, id: string) => Promise<void>;
  setSelectedSession: Dispatch<SetStateAction<SessionSummary | null>>;
  setError: (message: string | null) => void;
  /** 실패가 아닌 안내 한 줄. 실패 배너와 달리 오류코드가 붙지 않고 스스로 사라진다. */
  notify: (request: AppToastRequest) => void;
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
  // 기기 알림(PWA)을 눌러 들어온 열 대상. 창이 없어 새로 열렸으면 주소 쿼리로, 이미 떠 있던
  // 창이면 서비스워커 메시지로 온다. 알림 목록이 처음 도착한 뒤에 실제로 연다.
  const [notificationOpen, setNotificationOpen] = useState<NotificationOpenTarget | null>(() =>
    popoutRequest ? null : parseNotificationOpenSearch(window.location.search));
  const [attentionLoaded, setAttentionLoaded] = useState(false);

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
      setAttentionLoaded(true);
      // AIA는 일반 인앱 알림창에서만 분리한다. 기기 알림은 모든 프로필을 알려야 한다.
      // 중복 알림을 막기 위해 팝아웃 창은 표출하지 않는다(본 창이 대표로 보낸다).
      if (!popoutRequest) void notifyNewAttention(next.items, snapshotRef.current?.sessions ?? []);
    } catch (cause) {
      // 현재 알림 목록은 유지한 채, 폴링 루프만 백오프한다.
      throw cause;
    }
  }, [popoutRequest]);
  usePoll(pollAttention, 2_000);

  // 주소로 받은 열 대상은 읽은 즉시 주소에서 뗀다. 새로고침이 같은 알림을 다시 열지 않게.
  useEffect(() => {
    const stripped = stripNotificationOpenSearch(window.location.search);
    if (stripped === window.location.search) return;
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${stripped}${window.location.hash}`);
  }, []);

  // 떠 있는 창에는 서비스워커가 클릭한 알림의 대상을 메시지로 보낸다. 팝아웃 창은 본 창이
  // 대표로 받으므로 듣지 않는다.
  useEffect(() => {
    if (popoutRequest || !("serviceWorker" in navigator)) return undefined;
    const onMessage = (event: MessageEvent) => {
      const target = parseNotificationOpenMessage(event.data);
      if (target) setNotificationOpen(target);
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, [popoutRequest]);

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

  // 세션·AIA·채팅 뷰로 넘기는 알림 타깃은 같은 봉투를 쓴다. 요청 세대를 하나 올리고
  // 공통 네 칸을 채운다. 승인 대기는 화면에서 실제로 처리될 때 읽음이 되므로 여기서
  // 읽음 표시를 달지 않는다. 붙어 있는 채팅으로 열 때만 대상 채팅이 알림의 것과 다르다.
  const attentionTarget = useCallback((item: ChatAttentionItem, chatId = item.chatId): AttentionTarget => {
    attentionRequestId.current += 1;
    return {
      chatId,
      attentionId: item.id,
      markRead: item.kind !== "approval",
      requestId: attentionRequestId.current,
    };
  }, []);

  const findIndexedSession = useCallback((source: ProviderId, sessionId: string) => snapshotRef.current?.sessions
    .find((candidate) => candidate.source === source && candidate.id === sessionId) ?? null, [snapshotRef]);

  /**
   * 목록을 거치지 않고 공급자 원본에서 읽는 세션 한 건.
   *
   * 색인을 기다리는 것만으로는 끝내 열리지 않는 세션이 있다 — 목록에서 제외한 프로젝트의
   * 세션은 카탈로그가 일부러 걸러 내므로, 그 프로젝트에서 돈 무인 회차의 결과는 아무리
   * 기다려도 목록에 나타나지 않는다. 그런데 상세는 원본만 있으면 열리고, 사용자가 연 것은
   * 목록이 아니라 그 실행의 결과다. 색인이 못 올린 세션은 여기서 직접 찾아 연다.
   */
  const findProviderSession = useCallback(async (source: ProviderId, sessionId: string) => {
    try {
      return await getSessionSummary(source, sessionId);
    } catch {
      // 원본도 없는 세션(기록을 남기지 못한 실행)이다. 부르는 쪽이 안내로 처리한다.
      return null;
    }
  }, []);

  const openAttachedChat = useCallback((item: ChatAttentionItem, chatId: string) => {
    setChatViewAttentionTarget(attentionTarget(item, chatId));
    activateView("chat");
  }, [activateView, attentionTarget]);

  /**
   * 무인 예약 실행. 색인을 기다린 뒤에 화면을 옮기면 클릭하고도 몇 초 동안 아무 일이 없는
   * 것처럼 보인다. 목적지는 어차피 세션 화면이므로 먼저 옮기고, 대상은 색인이 끝나는 대로
   * 고른다.
   */
  const openUnattendedSessionAttention = useCallback((item: ChatAttentionItem, sessionId: string) => {
    const indexed = findIndexedSession(item.source, sessionId);
    setSessionAttentionTarget(null);
    let selectionAtClick: SessionSummary | null = null;
    setSelectedSession((current) => {
      selectionAtClick = current;
      // 대상을 아직 못 찾았어도 보던 세션 선택을 지우지는 않는다.
      return indexed ?? current;
    });
    setError(null);
    activateView("sessions");
    return (async () => {
      let session = indexed;
      if (!session) {
        await syncSessionCatalog(item.source, sessionId);
        // 색인이 올리지 못했어도 원본이 있으면 그 세션으로 연다(제외 프로젝트의 무인 실행).
        session = findIndexedSession(item.source, sessionId)
          ?? await findProviderSession(item.source, sessionId);
        // 기다리는 동안 사용자가 선택을 바꿨으면 그 선택을 빼앗지 않는다.
        if (session) {
          const found = session;
          setSelectedSession((current) => adoptFoundSession(current, selectionAtClick, found));
        }
      }
      if (!session) {
        notify({
          message: runtimeText(
            "예약 실행 세션의 기록을 아직 찾지 못했습니다. 잠시 뒤 세션 화면에서 다시 확인하세요.",
            "The scheduled run's session record isn't available yet. Check the Sessions screen again shortly.",
          ),
        });
        return;
      }
      if (item.kind !== "approval") await markAttentionRead(item.id);
    })();
  }, [activateView, findIndexedSession, findProviderSession, markAttentionRead, notify, setError, setSelectedSession, syncSessionCatalog]);

  /**
   * 공급자 세션이 이미 카탈로그에 있으면 런타임이 처음 시작된 화면(resuming 여부)이 아니라
   * 세션을 기준으로 연다. 알림 생성 뒤 같은 세션이 새 chatId로 이어져도 종료된 옛 채팅
   * 화면으로 이동하지 않고 세션 상세가 현재 실행을 다시 해석한다.
   */
  const openRoutedAttention = useCallback((item: ChatAttentionItem, sessionId: string) => (async () => {
    const route = await resolveAttentionRoute(item, {
      findIndexedSession: (id) => findIndexedSession(item.source, id),
      syncSessionCatalog: () => syncSessionCatalog(item.source, sessionId),
      findActiveChatId: async () =>
        (await getDetachedChatForSession(item.source, sessionId))?.chatId ?? null,
      findProviderSession: () => findProviderSession(item.source, sessionId),
    });
    if (route.kind === "chat") {
      openAttachedChat(item, route.chatId);
      return;
    }
    if (route.kind === "ended") {
      notify({
        message: runtimeText(
          "알림의 실행이 이미 끝났고 세션 기록도 아직 찾지 못했습니다. 잠시 뒤 세션 화면에서 다시 확인하세요.",
          "That run has already ended and its session record isn't available yet. Check the Sessions screen again shortly.",
        ),
      });
      return;
    }
    setSelectedSession(route.session);
    setSessionAttentionTarget({ ...attentionTarget(item), source: item.source, sessionId });
    activateView("sessions");
  })(), [activateView, attentionTarget, findIndexedSession, findProviderSession, notify, openAttachedChat, setSelectedSession, syncSessionCatalog]);

  // 알림 한 건이 어느 화면으로 가는지만 정한다. 실제로 여는 일은 갈래별 함수가 맡고,
  // 비동기로 가는 두 갈래의 실패는 여기서 한 번만 오류로 올린다.
  const openAttentionItem = useCallback((item: ChatAttentionItem) => {
    if (item.kind === "accountSwitch") {
      // 계정 전환은 채팅이 없다. 전환 이력이 있는 설정의 연결 탭으로 열고 읽음 처리한다.
      void markAttentionRead(item.id);
      requestSettingsTab("connections");
      activateView("settings");
      return;
    }
    if (item.kind === "pacingSuggestion") {
      // 페이싱 제안도 채팅이 없다. 조정을 실제로 하는 자리인 워크플로 페이싱 탭으로 연다.
      void markAttentionRead(item.id);
      requestWorkflowsTab("recurring");
      activateView("workflows");
      return;
    }
    if (item.profile === "aia") {
      setAiaAttentionTarget(attentionTarget(item));
      openAia();
      return;
    }
    const sessionId = item.providerSessionId;
    if (!sessionId) {
      // 공급자 세션 기록이 없으면 색인될 수 없다. 예약 실행이어도 세션 화면 대신
      // 붙어 있는 채팅으로 연다. 세션 화면에서 반영을 기다리면 영구히 실패한다.
      openAttachedChat(item, item.chatId);
      return;
    }
    void (item.unattended
      ? openUnattendedSessionAttention(item, sessionId)
      : openRoutedAttention(item, sessionId)
    ).catch((cause: unknown) => {
      setError(errorText(cause));
    });
  }, [activateView, attentionTarget, markAttentionRead, openAia, openAttachedChat, openRoutedAttention, openUnattendedSessionAttention, requestSettingsTab, requestWorkflowsTab, setError]);

  // 기기 알림으로 들어온 대상은 인앱 알림창에서 그 항목을 누른 것과 같이 연다. 알림이 그새
  // 지워졌으면 알림 목록에 없으므로 채팅 ID로 대화만 연다.
  useEffect(() => {
    if (!notificationOpen || !attentionLoaded) return;
    setNotificationOpen(null);
    const item = findNotificationOpenItem(notificationOpen, chatAttention.items);
    if (item) {
      openAttentionItem(item);
      return;
    }
    // 채팅이 없는 알림(계정 전환)이 그새 지워졌으면 앱을 앞으로 가져온 것으로 충분하다.
    if (!notificationOpen.chatId) return;
    attentionRequestId.current += 1;
    setChatViewAttentionTarget({ chatId: notificationOpen.chatId, attentionId: "", markRead: false, requestId: attentionRequestId.current });
    activateView("chat");
  }, [notificationOpen, attentionLoaded, chatAttention.items, openAttentionItem, activateView]);

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
