import { RotateCcw } from "lucide-react";
import { useI18n } from "../lib/i18n";
import type { TranslationStatus } from "../types";

export function TranslationProgress({ enabled, status, error, onRetry }: {
  enabled: boolean;
  status: TranslationStatus | null | undefined;
  error?: string | null;
  onRetry?: () => void;
}) {
  const { text } = useI18n();
  if (!enabled) return null;
  const phase = status?.phase ?? "queued";
  if (phase === "complete") return null;
  const label = phase === "running"
    ? text("번역 중", "Translating")
    : phase === "partial"
      ? text("일부 번역 실패", "Partially failed")
      : phase === "paused"
        ? text("번역 일시 중지", "Translation paused")
        : phase === "error"
          ? text("번역 오류", "Translation error")
          : text("번역 대기", "Translation queued");
  // 캐시를 재사용한 항목은 이번 실행에서 번역하지 않으므로 진행률에서 빼고 센다.
  const cached = status?.cached ?? 0;
  const segmentCached = status?.segmentCached ?? 0;
  const total = Math.max((status?.total ?? 0) - cached, 0);
  const complete = Math.max((status?.completed ?? 0) - cached, 0);
  const failed = status?.failed ?? 0;
  const segmentTotal = Math.max((status?.segmentTotal ?? 0) - segmentCached, 0);
  const segmentComplete = Math.max((status?.segmentCompleted ?? 0) - segmentCached, 0);
  const segmentFailed = status?.segmentFailed ?? 0;
  const hasSplitRequests = segmentTotal > total;
  const progressTotal = hasSplitRequests ? segmentTotal : total;
  const progressValue = hasSplitRequests ? segmentComplete + segmentFailed : complete + failed;
  const count = total > 0
    ? text(`항목 ${complete + failed}/${total}`, `items ${complete + failed}/${total}`)
    : "";
  const cachedNote = cached > 0
    ? text(`캐시 재사용 ${cached}`, `reused ${cached}`)
    : "";
  const requestProgress = hasSplitRequests
    ? text(`요청 ${segmentComplete + segmentFailed}/${segmentTotal}`, `requests ${segmentComplete + segmentFailed}/${segmentTotal}`)
    : "";
  const currentField = phase === "running" && status?.currentField
    ? text(`현재 ${translationFieldName(status.currentField, "ko")}`, `current ${translationFieldName(status.currentField, "en")}`)
    : "";
  const meta = [requestProgress, cachedNote, currentField].filter(Boolean).join(" · ");
  const detail = error ?? status?.lastError;
  return (
    <div className={`translation-progress ${phase}`} role="status">
      <span>{label}{count ? ` · ${count}` : ""}</span>
      {progressTotal > 0 && <progress max={progressTotal} value={progressValue} />}
      {meta && <small>{meta}</small>}
      {detail && <small title={detail}>{detail}</small>}
      {(phase === "partial" || phase === "error") && onRetry && (
        <button className="button secondary compact" type="button" onClick={onRetry}>
          <RotateCcw size={13} /> {text("실패 항목 재시도", "Retry failures")}
        </button>
      )}
    </div>
  );
}

function translationFieldName(field: string, locale: "ko" | "en"): string {
  const names: Record<string, [string, string]> = {
    resource: ["카드", "card"], name: ["이름", "name"], description: ["설명", "description"], title: ["제목", "title"], summary: ["요약", "summary"], body: ["본문", "body"],
  };
  const value = names[field] ?? [field, field];
  return value[locale === "ko" ? 0 : 1];
}
