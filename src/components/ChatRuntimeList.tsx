import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { AppWindow, PanelLeftClose, Plus, Star, X } from "lucide-react";
import { sourceName } from "../lib/format";
import { useI18n } from "../lib/i18n";
import { readSecondaryPaneOpen, writeSecondaryPaneOpen } from "../lib/secondaryPane";
import { CHAT_LIST_OPEN_KEY } from "./ChatLocalSettings";
import { useEscapeToClose } from "./Shared";
import type { ChatPhase, ChatSessionInfo, SessionSummary } from "../types";

/** 채팅 목록이 붙박이 사이드바에서 본문을 덮는 오버레이로 바뀌는 폭. CSS의 같은 중단점과 짝이다. */
const CHAT_LIST_OVERLAY_QUERY = "(max-width: 760px)";

/**
 * 채팅 목록 사이드바의 열림 상태를 맡는다. 저장된 열림 여부 복원, 좁은 화면일 때의
 * 오버레이 판정과 Esc 닫기, 토글 뒤 초점을 사라지지 않는 버튼으로 옮기는 일까지 한
 * 덩어리다. 화면 본문에 흩어져 있을 때는 이 넷이 서로를 전제로 움직인다는 사실이
 * 상태 선언과 이펙트 사이에 묻혀 있었다.
 *
 * 팝아웃 창에는 목록 자체가 없으므로 열림 여부를 저장하지도, Esc를 가로채지도 않는다.
 */
export function useChatListPane(popout: boolean) {
  const [open, setOpen] = useState(() => !popout && readSecondaryPaneOpen(CHAT_LIST_OPEN_KEY));
  const closeRef = useRef<HTMLButtonElement>(null);
  const restoreRef = useRef<HTMLButtonElement>(null);
  const focusTargetRef = useRef<"close" | "restore" | null>(null);
  // 좁은 화면에서만 채팅 목록이 본문을 덮는 오버레이가 된다. 그때만 Esc로 닫고,
  // 넓은 화면의 붙박이 사이드바일 때는 Esc를 가로채지 않는다.
  const [isOverlay, setIsOverlay] = useState(() => window.matchMedia(CHAT_LIST_OVERLAY_QUERY).matches);
  useEffect(() => {
    const query = window.matchMedia(CHAT_LIST_OVERLAY_QUERY);
    const sync = () => setIsOverlay(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);
  useEffect(() => {
    if (!popout) writeSecondaryPaneOpen(CHAT_LIST_OPEN_KEY, open);
  }, [open, popout]);
  useLayoutEffect(() => {
    const target = focusTargetRef.current;
    if (!target) return;
    focusTargetRef.current = null;
    if (target === "close") closeRef.current?.focus();
    else restoreRef.current?.focus();
  }, [open]);
  const setVisibility = (next: boolean) => {
    focusTargetRef.current = next ? "close" : "restore";
    setOpen(next);
  };
  const closeAndRestoreFocus = () => {
    setVisibility(false);
  };
  // 오버레이일 때만 닫는다. 목록에서 채팅을 고르면 본문이 목록에 가려 있으므로 비켜 주고,
  // 붙박이 사이드바일 때는 고른 뒤에도 목록이 그대로 있어야 다음 채팅으로 옮겨갈 수 있다.
  const closeOnOverlay = () => {
    if (isOverlay) closeAndRestoreFocus();
  };
  useEscapeToClose(closeAndRestoreFocus, open && isOverlay && !popout);
  return { open, closeRef, restoreRef, setVisibility, closeAndRestoreFocus, closeOnOverlay };
}

type ChatListPane = ReturnType<typeof useChatListPane>;

export function chatCatalogSession(chat: ChatSessionInfo, sessions: SessionSummary[]): SessionSummary | null {
  return chat.providerSessionId
    ? sessions.find((candidate) => candidate.source === chat.source && candidate.id === chat.providerSessionId) ?? null
    : null;
}

export function chatTabTitle(chat: ChatSessionInfo, session: SessionSummary | null): string {
  const parts = chat.cwd.split(/[\\/]/).filter(Boolean);
  const fallback = parts[parts.length - 1] ?? sourceName(chat.source);
  return session?.title ?? `${fallback} · ${chat.chatId.slice(0, 4)}`;
}

type TextPicker = (ko: string, en: string) => string;

export function phaseLabel(phase: ChatPhase | "connecting", text: TextPicker): string {
  return phase === "connecting" ? text("연결 중", "Connecting")
    : phase === "ready" ? text("입력 대기", "Ready")
      : phase === "running" ? text("응답 중", "Responding")
        : phase === "waitingApproval" ? text("승인 대기", "Awaiting approval")
          : phase === "stopped" ? text("종료됨", "Stopped")
            : text("오류", "Error");
}

/**
 * 열려 있는 채팅 목록 사이드바. 오버레이일 때 본문을 덮는 배경까지 함께 그린다 —
 * 배경은 목록이 있을 때만 있고 목록과 같은 자리에 놓이므로 둘을 떼어 놓을 이유가 없다.
 *
 * 팝아웃 창에는 목록이 없다. 이 대화 하나만 담당하는 창이라 옮겨갈 곳이 없기 때문이다.
 */
export function ChatRuntimeList({ pane, chats, sessions, activeChatId, busy, popout, onNewChat, onSwitchChat, onToggleFavorite, onPopOut, onStopChat }: {
  pane: ChatListPane;
  chats: ChatSessionInfo[];
  sessions: SessionSummary[];
  activeChatId: string | null;
  busy: boolean;
  popout: boolean;
  onNewChat: () => Promise<void>;
  onSwitchChat: (chatId: string) => Promise<boolean>;
  onToggleFavorite: (chat: ChatSessionInfo) => void;
  onPopOut: (chatId: string) => void;
  onStopChat: (chat: ChatSessionInfo) => void;
}) {
  const { text } = useI18n();
  if (!pane.open || popout) return null;
  return <>
    <aside className="chat-runtime-list" id="chat-runtime-list" aria-label={text("열린 채팅 목록", "Open chats")}>
      <header>
        <div><strong>{text("채팅", "Chat")}</strong><span>{chats.length}</span></div>
        <button ref={pane.closeRef} className="secondary-pane-toggle" type="button" aria-label={text("채팅 목록 숨기기", "Hide chat list")} title={text("채팅 목록 숨기기", "Hide chat list")} onClick={pane.closeAndRestoreFocus}><PanelLeftClose size={15} /></button>
      </header>
      <div className="chat-runtime-list-items">
        <button className={`chat-runtime-list-new${activeChatId ? "" : " active"}`} type="button" aria-current={!activeChatId ? "page" : undefined} disabled={busy} onClick={() => { void onNewChat().then(pane.closeOnOverlay); }}>
          <span><Plus size={15} aria-hidden="true" /></span><strong>{text("새 채팅", "New chat")}</strong>
        </button>
        {chats.map((chat) => {
          const active = activeChatId === chat.chatId;
          const catalogSession = chatCatalogSession(chat, sessions);
          const title = chatTabTitle(chat, catalogSession);
          const favorite = Boolean(catalogSession?.meta.favorite);
          const favoriteLabel = !catalogSession
            ? text("세션이 만들어진 뒤 즐겨찾기할 수 있습니다", "You can favorite this once its session exists")
            : favorite ? text("즐겨찾기 해제", "Remove from favorites") : text("즐겨찾기 추가", "Add to favorites");
          return <div className={`chat-runtime-list-item-shell${active ? " active" : ""}`} key={chat.chatId}>
            <button className="chat-runtime-list-item" type="button" aria-current={active ? "page" : undefined} disabled={busy} title={`${title} · ${sourceName(chat.source)} · ${phaseLabel(chat.state, text)}`} onClick={() => { void onSwitchChat(chat.chatId).then((opened) => { if (opened) pane.closeOnOverlay(); }); }}>
              <span className={`terminal-status terminal-status-${chat.state}`} />
              <span><strong>{title}</strong><small>{sourceName(chat.source)} · {phaseLabel(chat.state, text)}</small></span>
            </button>
            <div className="chat-runtime-list-item-actions">
              <button className={`chat-runtime-list-favorite${favorite ? " active" : ""}`} type="button" disabled={busy || !catalogSession} aria-pressed={favorite} aria-label={`${title} ${favoriteLabel}`} title={favoriteLabel} onClick={() => { onToggleFavorite(chat); }}><Star size={12} fill={favorite ? "currentColor" : "none"} /></button>
              <button className="chat-runtime-list-popout" type="button" disabled={busy} aria-label={`${title} 새 창으로 열기`} title="새 창으로 열기" onClick={() => onPopOut(chat.chatId)}><AppWindow size={12} /></button>
              <button className="chat-runtime-list-close" type="button" disabled={busy} aria-label={`${title} 실행 종료 및 목록에서 제거`} title="실행 종료 및 목록에서 제거" onClick={() => { onStopChat(chat); }}><X size={12} /></button>
            </div>
          </div>;
        })}
      </div>
    </aside>
    <button className="chat-runtime-list-backdrop" type="button" aria-label={text("채팅 목록 닫기", "Close chat list")} onClick={pane.closeAndRestoreFocus} />
  </>;
}
