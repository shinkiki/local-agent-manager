import { useCallback, useState } from "react";
import { formatBytes } from "../lib/format";
import { useI18n } from "../lib/i18n";
import { getStorageOverview } from "../lib/ipc";
import { usePoll } from "../lib/poll";
import type { StorageOverview, StorageUsageItem } from "../types";
import { ErrorBanner, LoadingState } from "./Shared";
import { errorText } from "../lib/errorText";

/** 측정 시각 표기. 저장소 화면은 같은 날 안에서 30초마다 다시 재므로 시:분:초만 적는다. */
const MEASURED_AT_FORMATTER = new Intl.DateTimeFormat("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

export function StorageView() {
  const { text } = useI18n();
  // 마지막으로 성공한 측정과 그 시각을 한 짝으로 든다. 갱신이 실패해도 옛 수치는 남기되,
  // 그 수치가 어느 시점 것인지와 갱신이 멈췄음을 화면 위쪽에서 바로 알린다(QA #47).
  const [measured, setMeasured] = useState<{ overview: StorageOverview; at: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const next = await getStorageOverview();
      setMeasured({ overview: next, at: Date.now() });
      setError(null);
    } catch (cause) {
      setError(errorText(cause));
      throw cause;
    }
  }, []);
  usePoll(load, 30_000);

  if (!measured && !error) return <LoadingState label={text("로컬 저장소 사용량을 계산하고 있습니다", "Calculating local storage usage…")} />;
  if (!measured) return <ErrorBanner message={error ?? text("저장소 사용량을 읽지 못했습니다", "Failed to read storage usage.")} />;

  const { overview, at } = measured;
  const stale = error !== null;
  const measuredAtText = MEASURED_AT_FORMATTER.format(new Date(at));

  return (
    <div className="view-stack storage-view">
      {/* 갱신 실패는 본문 맨 아래가 아니라 맨 위에서 알린다 — 기본 뷰포트에서 본문이 화면보다
          길어 아래 배너는 스크롤 밖으로 밀려 보이지 않았다(QA #47). */}
      {error && <ErrorBanner message={error} />}
      <p className={`settings-storage-note storage-refresh-status${stale ? " is-stale" : ""}`} role="status" data-ui-anchor="storage.refresh-status">
        {stale
          ? text(`갱신 실패 · 아래 수치는 마지막 측정 시각 ${measuredAtText} 기준입니다`, `Refresh failed · figures below are from the last measurement at ${measuredAtText}`)
          : text(`마지막 측정 시각 ${measuredAtText} · 30초마다 다시 잽니다`, `Last measured at ${measuredAtText} · re-measured every 30 seconds`)}
      </p>
      <section className={`stat-grid${stale ? " is-stale" : ""}`}>
        <StorageStat
          label={text("관리 대상 전체", "All managed data")}
          value={formatBytes(overview.totalBytes)}
          detail={text("대화 원본 + Agent Manager 상태", "Provider transcripts + Agent Manager state")}
          stale={stale}
          measuredAtText={measuredAtText}
        />
        <StorageStat
          label={text("공급자 대화 원본", "Provider transcripts")}
          value={formatBytes(overview.sourceTotalBytes)}
          detail={text("원본 파일은 읽기 전용", "Original files are read-only")}
          stale={stale}
          measuredAtText={measuredAtText}
        />
        <StorageStat
          label={text("Agent Manager 상태", "Agent Manager state")}
          value={formatBytes(overview.managerTotalBytes)}
          detail={text("보완 응답과 반복 요청 포함", "Includes supplements and recurring requests")}
          stale={stale}
          measuredAtText={measuredAtText}
        />
        <StorageStat
          label={text("보완 저장 결과", "Stored supplements")}
          value={text(`${overview.supplements.turnCount.toLocaleString()}건`, `${overview.supplements.turnCount.toLocaleString()} turns`)}
          detail={text(
            `${overview.supplements.sessionCount.toLocaleString()}개 세션 · ${formatBytes(overview.supplements.sizeBytes)}`,
            `${overview.supplements.sessionCount.toLocaleString()} sessions · ${formatBytes(overview.supplements.sizeBytes)}`,
          )}
          stale={stale}
          measuredAtText={measuredAtText}
        />
      </section>

      <section className="storage-grid">
        <StoragePanel
          title={text("공급자 대화 원본", "Provider transcripts")}
          detail={text(
            "공급자가 생성한 로컬 세션 데이터입니다. Agent Manager는 이 파일을 수정하지 않습니다.",
            "Local session data created by providers. Agent Manager does not modify these files.",
          )}
          items={overview.sourceItems}
        />
        <StoragePanel
          title={text("Agent Manager 보완 저장소", "Agent Manager supplement store")}
          detail={text(
            "실행 중 받은 최종 assistant 응답을 턴 완료 시 기록합니다. 원본 대화에 같은 응답이 있으면 세션 화면에서 한 번만 표시합니다.",
            "Records the final assistant response upon turn completion. If already present in original transcripts, it appears only once in the session view.",
          )}
          items={overview.managerItems}
          footer={text(
            `보완 응답 ${overview.supplements.turnCount.toLocaleString()}건 · 최대 세션당 200건, 전체 4,000건 보관`,
            `${overview.supplements.turnCount.toLocaleString()} supplement responses · retained up to 200/session, 4,000 total`,
          )}
        />
      </section>
    </div>
  );
}

function StorageStat({ label, value, detail, stale, measuredAtText }: { label: string; value: string; detail: string; stale: boolean; measuredAtText: string }) {
  const { text } = useI18n();
  // 낡은 값은 카드 자체에도 측정 시각을 달아, 배너를 지나쳐도 어느 시점 값인지 읽힌다.
  const shown = stale ? text(`${measuredAtText} 측정 · 갱신 실패`, `Measured ${measuredAtText} · refresh failed`) : detail;
  return <article className={`stat-card${stale ? " is-stale" : ""}`} title={stale ? detail : undefined}><span>{label}</span><strong>{value}</strong><small>{shown}</small></article>;
}

function StoragePanel({ title, detail, items, footer }: { title: string; detail: string; items: StorageUsageItem[]; footer?: string }) {
  return (
    <article className="panel storage-panel">
      <div className="panel-heading"><div><h2>{title}</h2><p>{detail}</p></div></div>
      <div className="storage-list">
        {items.map((item) => <StorageRow item={item} key={item.id} />)}
      </div>
      {footer && <footer>{footer}</footer>}
    </article>
  );
}

function StorageRow({ item }: { item: StorageUsageItem }) {
  const { text } = useI18n();
  return (
    <div className="storage-row">
      <div><strong>{item.label}</strong><span>{item.description}</span></div>
      <div><strong>{formatBytes(item.sizeBytes)}</strong><span>{text(`${item.fileCount.toLocaleString()}개 파일`, `${item.fileCount.toLocaleString()} files`)}</span></div>
    </div>
  );
}
