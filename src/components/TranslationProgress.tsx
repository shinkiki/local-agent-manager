import { Languages, RotateCcw } from "lucide-react";
import { useState } from "react";
import { translateResource } from "../lib/ipc";
import { useI18n } from "../lib/i18n";
import type { SystemAutomationSnapshot, TranslationMenu, TranslationStatus } from "../types";
import { errorText } from "../lib/errorText";

/**
 * 상세 화면에서 리소스 하나를 번역·재번역하는 버튼. 메뉴 자동번역 토글과 무관하게
 * 동작하며, 이미 번역이 있으면 캐시를 건너뛰고 다시 번역한다. 원문 그대로 돌아온
 * 번역을 항목 단위로 되돌릴 수 있는 유일한 경로다.
 */
export function TranslateResourceButton({ menu, resourceId, alsoResourceIds, translated, automation, onAutomationChange }: {
  menu: TranslationMenu;
  resourceId: string;
  /**
   * 같은 클릭으로 함께 번역할 딸린 리소스. 아티팩트 드로어가 대화 그룹 제목을 함께
   * 올리는 데 쓴다. 원문이 없어 실패해도 버튼 상태에는 반영하지 않는다.
   */
  alsoResourceIds?: string[];
  translated: boolean;
  automation: SystemAutomationSnapshot | null;
  onAutomationChange: (snapshot: SystemAutomationSnapshot) => void;
}) {
  const { text } = useI18n();
  const [requesting, setRequesting] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);
  const job = (automation?.resourceTranslations ?? [])
    .find((item) => item.menu === menu && item.resourceId === resourceId);
  const running = requesting || job?.phase === "queued" || job?.phase === "running";
  const failure = requestError ?? (job?.phase === "error" ? job.lastError : null);
  // 시스템 에이전트가 없으면 어떤 번역도 실행할 수 없다. 누를 수 있게 두면 매번
  // 같은 오류만 돌려주므로 이유를 붙여 막는다.
  const unavailable = !automation?.settings.systemProvider;
  // 진행 숫자는 별도 노드로 둔다. 라벨 텍스트 노드를 그대로 유지해야 추가 언어 UI
  // 번역이 이 버튼에도 적용된다.
  const progress = running && job && job.segmentTotal > 1
    ? ` ${job.segmentCompleted}/${job.segmentTotal}`
    : "";
  const label = running
    ? text("번역 중", "Translating")
    : failure
      ? text("번역 실패", "Translation failed")
      : translated
        ? text("재번역", "Retranslate")
        : text("번역", "Translate");
  const request = async () => {
    setRequesting(true);
    setRequestError(null);
    try {
      let snapshot = await translateResource(menu, resourceId);
      for (const extra of alsoResourceIds ?? []) {
        if (extra === resourceId) continue;
        try {
          snapshot = await translateResource(menu, extra);
        } catch {
          // 딸린 리소스는 원문이 없을 수 있다. 주 리소스 번역은 계속 진행한다.
        }
      }
      onAutomationChange(snapshot);
    } catch (cause) {
      setRequestError(errorText(cause));
    } finally {
      setRequesting(false);
    }
  };
  return (
    <button
      className={`button compact${failure && !running ? " danger-subtle" : " secondary"}`}
      type="button"
      disabled={running || unavailable}
      title={failure ?? (unavailable
        ? text("먼저 CLI가 연결된 시스템 에이전트를 선택하세요.", "Select a connected system agent first.")
        : undefined)}
      onClick={() => { void request(); }}
    >
      <Languages size={13} aria-hidden="true" />{label}{progress && <span>{progress}</span>}
    </button>
  );
}

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
