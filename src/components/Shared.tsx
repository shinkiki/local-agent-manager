import { useEffect, useRef, useState, type PropsWithChildren, type ReactNode, type Ref } from "react";
import { Check, ChevronDown, Inbox, Paperclip, Square, Undo2, X } from "lucide-react";
import { sourceName } from "../lib/format";
import type { ChatApprovalDecision, ProviderId, QueuedChatMessage } from "../types";
import { useI18n } from "../lib/i18n";

export function SourceBadge({ source }: { source: ProviderId }) {
  return <span className={`source-badge source-${source}`}>{sourceName(source)}</span>;
}

export function LogoMark({ size = 37 }: { size?: number }) {
  return (
    <svg className="logo-mark" width={size} height={size} viewBox="0 0 64 64" role="img" aria-label="Agent Manager 로고">
      <defs>
        <linearGradient id="lmBg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#131e2c" />
          <stop offset="1" stopColor="#0a121c" />
        </linearGradient>
      </defs>
      <rect x="1" y="1" width="62" height="62" rx="14" fill="url(#lmBg)" />
      <g transform="translate(32 32) scale(0.0735) translate(-512 -512)">
        <g stroke="#f0b054" fill="none">
          <circle cx="512" cy="512" r="196" strokeWidth="42" />
          <g strokeWidth="52" strokeLinecap="round">
            <path d="M512 294 L512 190" />
            <path d="M666.1 357.9 L739.7 284.3" />
            <path d="M730 512 L834 512" />
            <path d="M666.1 666.1 L739.7 739.7" />
            <path d="M512 730 L512 834" />
            <path d="M357.9 666.1 L284.3 739.7" />
            <path d="M294 512 L190 512" />
            <path d="M357.9 357.9 L284.3 284.3" />
          </g>
          <g strokeWidth="26">
            <path d="M512 404 L512 332" />
            <path d="M588.4 435.6 L639.3 384.7" />
            <path d="M620 512 L692 512" />
            <path d="M588.4 588.4 L639.3 639.3" />
            <path d="M512 620 L512 692" />
            <path d="M435.6 588.4 L384.7 639.3" />
            <path d="M404 512 L332 512" />
            <path d="M435.6 435.6 L384.7 384.7" />
          </g>
        </g>
        <circle cx="512" cy="512" r="122" fill="#f0b054" />
        <path d="M478 458 L550 512 L478 566" fill="none" stroke="#0e1724" strokeWidth="36" strokeLinecap="round" strokeLinejoin="round" />
      </g>
      <rect x="1.5" y="1.5" width="61" height="61" rx="13.5" fill="none" stroke="#ffffff" strokeOpacity="0.07" strokeWidth="1" />
    </svg>
  );
}

/** AIA 마크: 나침반 — 타륜 앱 아이콘과 같은 항해 도구 계열. 링·4방위 틱·NE 방향 바늘(앞쪽 솔리드, 뒤쪽 반투명)로 16px에서도 형태가 유지된다. */
export function AiaMark({ size = 16 }: { size?: number }) {
  return (
    <svg className="aia-mark" width={size} height={size} viewBox="0 0 32 32" fill="currentColor" aria-hidden="true">
      <circle cx="16" cy="16" r="13" fill="none" stroke="currentColor" strokeWidth="2.4" />
      <g stroke="currentColor" strokeWidth="1.7" opacity="0.55" fill="none">
        <path d="M16 5.1 L16 7.1" />
        <path d="M26.9 16 L24.9 16" />
        <path d="M16 26.9 L16 24.9" />
        <path d="M5.1 16 L7.1 16" />
      </g>
      <path d="M8.79 23.21 L18.19 18.19 L13.81 13.81 Z" opacity="0.42" />
      <path d="M23.21 8.79 L18.19 18.19 L13.81 13.81 Z" />
      <circle cx="16" cy="16" r="2.1" />
    </svg>
  );
}

export function LoadingState({ label = "로컬 데이터를 읽고 있습니다" }: { label?: string }) {
  return (
    <div className="state-panel">
      <span className="spinner" aria-hidden="true" />
      <p>{label}</p>
    </div>
  );
}

export function EmptyState({ title, detail }: { title: string; detail?: string }) {
  return (
    <div className="empty-state">
      <span aria-hidden="true"><Inbox size={22} strokeWidth={1.6} /></span>
      <strong>{title}</strong>
      {detail && <p>{detail}</p>}
    </div>
  );
}

export function Drawer({ title, actions, headerContent, onClose, bodyRef, bodyOverlay, footer, children }: PropsWithChildren<{ title: ReactNode; actions?: ReactNode; headerContent?: ReactNode; onClose: () => void; bodyRef?: Ref<HTMLDivElement>; bodyOverlay?: ReactNode; footer?: ReactNode }>) {
  return (
    <div className="drawer-backdrop" role="presentation" onMouseDown={onClose}>
      <section className={`drawer${footer ? " drawer-with-footer" : ""}`} role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
        <div className="drawer-chrome">
          <header className="drawer-header">
            <div className="drawer-title">{title}</div>
            <div className="drawer-header-actions">
              {actions}
              <button className="icon-button" type="button" onClick={onClose} aria-label="닫기">
                <X size={16} />
              </button>
            </div>
          </header>
          {headerContent && <div className="drawer-header-content">{headerContent}</div>}
        </div>
        <div className="drawer-body-shell">
          <div className="drawer-body" ref={bodyRef}>{children}</div>
          {bodyOverlay}
        </div>
        {footer && <div className="drawer-footer">{footer}</div>}
      </section>
    </div>
  );
}

export function ErrorBanner({ message }: { message: string }) {
  const { text } = useI18n();
  return <div className="error-banner"><strong>{text("요청을 처리하지 못했습니다.", "The request could not be completed.")} <code>{stableErrorCode(message)}</code></strong><span>{message}</span></div>;
}

export interface ChatApprovalPrompt {
  id: string;
  title: string;
  detail: string;
  options: ChatApprovalDecision[];
  interactive: boolean;
  resolved: ChatApprovalDecision | null;
}

export function ChatApprovalCard({ prompt, onDecision }: { prompt: ChatApprovalPrompt; onDecision: (id: string, decision: ChatApprovalDecision) => void }) {
  const offered = new Set(prompt.options);
  return (
    <article className={`chat-approval${prompt.interactive && !prompt.resolved ? " chat-approval-pending" : ""}`} role={prompt.interactive && !prompt.resolved ? "alert" : undefined}>
      <strong>{prompt.title}</strong>
      {prompt.detail && <pre>{prompt.detail}</pre>}
      {prompt.resolved ? (
        <span className="chat-approval-result">{approvalDecisionLabel(prompt.resolved)}</span>
      ) : prompt.interactive ? (
        <div>
          {offered.has("accept") && <button className="button primary" type="button" onClick={() => onDecision(prompt.id, "accept")}>이번만 허용</button>}
          {offered.has("acceptForSession") && <button className="button" type="button" onClick={() => onDecision(prompt.id, "acceptForSession")}>세션 동안 허용</button>}
          {offered.has("decline") && <button className="button danger-subtle" type="button" onClick={() => onDecision(prompt.id, "decline")}>거절</button>}
          {offered.has("cancel") && <button className="button danger-subtle" type="button" onClick={() => onDecision(prompt.id, "cancel")}>작업 취소</button>}
        </div>
      ) : (
        <p>실행 정책에 의해 이미 거절된 권한 기록입니다. 현재 승인을 기다리고 있지 않습니다.</p>
      )}
    </article>
  );
}

function approvalDecisionLabel(decision: ChatApprovalDecision): string {
  if (decision === "accept") return "이번 요청을 허용했습니다";
  if (decision === "acceptForSession") return "이 세션 동안 허용했습니다";
  if (decision === "decline") return "요청을 거절했습니다";
  return "작업을 취소했습니다";
}

function stableErrorCode(message: string): string {
  const normalized = message.toLowerCase();
  if (normalized.includes("권한") || normalized.includes("forbidden") || normalized.includes("permission")) return "APP_ACCESS_DENIED";
  if (normalized.includes("보안 저장소") || normalized.includes("secure storage")) return "APP_CREDENTIALS";
  if (normalized.includes("찾을 수 없") || normalized.includes("not found")) return "APP_NOT_FOUND";
  if (normalized.includes("시간이 초과") || normalized.includes("timeout")) return "APP_TIMEOUT";
  if (normalized.includes("충돌") || normalized.includes("conflict") || normalized.includes("already") || normalized.includes("계정을 전환할 수 없") || normalized.includes("전환될 때까지 대기")) return "APP_CONFLICT";
  if (normalized.includes("연결") || normalized.includes("websocket") || normalized.includes("network")) return "APP_CONNECTION";
  if (normalized.includes("입력") || normalized.includes("invalid")) return "APP_INVALID_INPUT";
  return "APP_RUNTIME";
}

export function ChatQueueList({
  items,
  onRemove,
  onRecall,
}: {
  items: QueuedChatMessage[];
  onRemove: (messageId: string) => void;
  onRecall: (item: QueuedChatMessage) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div className="chat-queue" aria-label="대기 중인 메시지">
      <header>대기열 {items.length}개 · 응답이 끝나면 순서대로 전송됩니다</header>
      {items.map((item, index) => (
        <div className="chat-queue-item" key={item.id}>
          <span className="chat-queue-index">{index + 1}</span>
          <p title={item.text || item.attachments.map((file) => file.name).join(", ")}>{item.text || "첨부 파일"}{item.attachments.length > 0 && <small><Paperclip size={11} /> {item.attachments.map((file) => file.name).join(", ")}</small>}</p>
          <button type="button" title="입력창으로 되돌리기" aria-label="입력창으로 되돌리기" onClick={() => onRecall(item)}><Undo2 size={13} /></button>
          <button type="button" title="대기열에서 삭제" aria-label="대기열에서 삭제" onClick={() => onRemove(item.id)}><X size={13} /></button>
        </div>
      ))}
    </div>
  );
}

export function ChatBusyComposerActions({
  hasDraft,
  sendDisabled,
  sending,
  onInterrupt,
  onQueue,
  onSteer,
}: {
  hasDraft: boolean;
  sendDisabled: boolean;
  sending: boolean;
  onInterrupt: () => void;
  onQueue: () => void;
  onSteer: () => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!hasDraft) setOpen(false);
  }, [hasDraft]);
  useEffect(() => {
    if (!open) return undefined;
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  const choose = (action: () => void) => {
    setOpen(false);
    action();
  };

  if (!hasDraft) {
    return <button className="button danger-subtle chat-stop-action" type="button" onClick={onInterrupt}><Square size={13} />중단</button>;
  }

  return <div className="chat-send-action-menu" ref={rootRef}>
      <button
        className="button primary chat-send-action-trigger"
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        {sending ? "첨부 중…" : "대기열 추가"}<ChevronDown size={13} />
      </button>
      {open && <div className="chat-send-action-popover" role="menu">
        <button type="button" role="menuitem" onClick={() => choose(onQueue)} disabled={sendDisabled}><span><strong>대기열 추가</strong><small>현재 응답이 끝난 뒤 순서대로 전송</small></span><Check size={13} /></button>
        <button type="button" role="menuitem" onClick={() => choose(onSteer)} disabled={sendDisabled}><span><strong>중단 후 전송</strong><small>현재 작업을 중단하고 이 요청을 우선 전송</small></span></button>
      </div>}
    </div>;
}
