/**
 * 실패가 아닌 앱 알림 한 벌 — 토스트.
 *
 * 화면 위쪽 실패 배너(`ErrorBanner`)는 "요청을 처리하지 못했습니다 + 오류코드"를 무조건
 * 붙인다. 그래서 "예약 실행 세션이 아직 목록에 반영되지 않았다" 같은 **진행 안내**를 그리
 * 보내면 앱이 고장 난 것처럼 읽히고, 배너를 거두는 쪽(연결 회복·목록 재조회)이 폴링
 * 주기마다 돌기 때문에 읽기도 전에 사라졌다.
 *
 * 토스트는 그 두 가지를 모두 뒤집는다 — 머리말과 코드가 없고, 사라지는 시각을 스스로
 * 들고 있어 폴링이 걷어 가지 않으며, 마우스를 올리거나 초점이 들어오면 멈춘다. 대신
 * **실패는 여기로 보내지 않는다.** 실패는 그 자리에 남아 재시도 버튼과 함께 읽혀야 한다.
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { CheckCircle2, Info, TriangleAlert, X } from "lucide-react";

import { useI18n } from "../lib/i18n";

export type AppToastTone = "info" | "success" | "warning";

export interface AppToastRequest {
  message: string;
  /** 기본은 `info`. 경고는 더 오래 남는다. */
  tone?: AppToastTone;
  /** 안내를 읽고 그 자리에서 할 수 있는 동작 하나(재시도·이동 등). */
  action?: { label: string; run: () => void };
}

interface AppToast extends AppToastRequest {
  id: number;
}

/** 톤별 표시 시간. 배너를 읽기도 전에 놓쳤다는 보고가 있어 넉넉하게 잡는다. */
const TOAST_DURATION_MS: Record<AppToastTone, number> = {
  info: 9_000,
  success: 7_000,
  warning: 14_000,
};

/** 동시에 쌓아 둘 최대 개수. 넘치면 오래된 것부터 밀려난다. */
const TOAST_LIMIT = 4;

export function useAppToasts() {
  const [toasts, setToasts] = useState<AppToast[]>([]);
  const lastId = useRef(0);

  const pushToast = useCallback((request: AppToastRequest) => {
    lastId.current += 1;
    const toast: AppToast = { ...request, id: lastId.current };
    // 같은 문장이 이미 떠 있으면 겹쳐 쌓지 않고 새것으로 갈아 끼운다 — 알림을 연달아
    // 누르면 같은 안내가 세 줄씩 쌓였다.
    setToasts((current) => [...current.filter((item) => item.message !== toast.message), toast].slice(-TOAST_LIMIT));
    return toast.id;
  }, []);

  const dismissToast = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  return { toasts, pushToast, dismissToast };
}

export function AppToastStack({ toasts, onDismiss }: {
  toasts: AppToast[];
  onDismiss: (id: number) => void;
}) {
  if (toasts.length === 0) return null;
  return (
    <div className="app-toasts" role="status" aria-live="polite">
      {toasts.map((toast) => <AppToastCard key={toast.id} toast={toast} onDismiss={onDismiss} />)}
    </div>
  );
}

function AppToastCard({ toast, onDismiss }: { toast: AppToast; onDismiss: (id: number) => void }) {
  const { text } = useI18n();
  const tone = toast.tone ?? "info";
  const duration = TOAST_DURATION_MS[tone];
  const [paused, setPaused] = useState(false);
  // 남은 시간은 상태가 아니라 ref다 — 멈췄다 다시 갈 때 처음부터 세지 않으려면 값이
  // 필요하지만, 매 순간 다시 그릴 이유는 없다(남은 시간 표시는 CSS 애니메이션이 한다).
  const remaining = useRef(duration);

  useEffect(() => {
    if (paused) return undefined;
    const startedAt = Date.now();
    const timer = window.setTimeout(() => onDismiss(toast.id), remaining.current);
    return () => {
      window.clearTimeout(timer);
      remaining.current = Math.max(0, remaining.current - (Date.now() - startedAt));
    };
  }, [onDismiss, paused, toast.id]);

  const Icon = tone === "warning" ? TriangleAlert : tone === "success" ? CheckCircle2 : Info;
  return (
    <div
      className={`app-toast app-toast-${tone}${paused ? " paused" : ""}`}
      style={{ "--toast-duration": `${duration}ms` } as CSSProperties}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <Icon className="app-toast-icon" size={15} aria-hidden="true" />
      <div className="app-toast-body">
        <span>{toast.message}</span>
        {toast.action && (
          <button className="button secondary app-toast-action" type="button" onClick={() => {
            onDismiss(toast.id);
            toast.action?.run();
          }}>{toast.action.label}</button>
        )}
      </div>
      <button
        className="app-toast-close"
        type="button"
        aria-label={text("알림 닫기", "Dismiss notice")}
        onClick={() => onDismiss(toast.id)}
      ><X size={13} aria-hidden="true" /></button>
      <span className="app-toast-progress" aria-hidden="true" />
    </div>
  );
}
