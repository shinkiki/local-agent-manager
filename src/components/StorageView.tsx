import { useEffect, useState } from "react";
import { formatBytes } from "../lib/format";
import { getStorageOverview } from "../lib/ipc";
import type { StorageOverview, StorageUsageItem } from "../types";
import { ErrorBanner, LoadingState } from "./Shared";

export function StorageView() {
  const [overview, setOverview] = useState<StorageOverview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const value = await getStorageOverview();
        if (!active) return;
        setOverview(value);
        setError(null);
      } catch (cause) {
        if (!active) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    };
    void load();
    const timer = window.setInterval(() => { void load(); }, 30_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  if (!overview && !error) return <LoadingState label="로컬 저장소 사용량을 계산하고 있습니다" />;
  if (!overview) return <ErrorBanner message={error ?? "저장소 사용량을 읽지 못했습니다"} />;

  return (
    <div className="view-stack storage-view">
      <section className="stat-grid">
        <StorageStat label="관리 대상 전체" value={formatBytes(overview.totalBytes)} detail="대화 원본 + Agent Manager 상태" />
        <StorageStat label="공급자 대화 원본" value={formatBytes(overview.sourceTotalBytes)} detail="원본 파일은 읽기 전용" />
        <StorageStat label="Agent Manager 상태" value={formatBytes(overview.managerTotalBytes)} detail="보완 응답과 반복 요청 포함" />
        <StorageStat label="보완 저장 결과" value={`${overview.supplements.turnCount.toLocaleString()}건`} detail={`${overview.supplements.sessionCount.toLocaleString()}개 세션 · ${formatBytes(overview.supplements.sizeBytes)}`} />
      </section>

      <section className="storage-grid">
        <StoragePanel
          title="공급자 대화 원본"
          detail="공급자가 생성한 로컬 세션 데이터입니다. Agent Manager는 이 파일을 수정하지 않습니다."
          items={overview.sourceItems}
        />
        <StoragePanel
          title="Agent Manager 보완 저장소"
          detail="실행 중 받은 최종 assistant 응답을 턴 완료 시 기록합니다. 원본 대화에 같은 응답이 있으면 세션 화면에서 한 번만 표시합니다."
          items={overview.managerItems}
          footer={`보완 응답 ${overview.supplements.turnCount.toLocaleString()}건 · 최대 세션당 200건, 전체 4,000건 보관`}
        />
      </section>
      {error && <ErrorBanner message={error} />}
    </div>
  );
}

function StorageStat({ label, value, detail }: { label: string; value: string; detail: string }) {
  return <article className="stat-card"><span>{label}</span><strong>{value}</strong><small>{detail}</small></article>;
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
  return (
    <div className="storage-row">
      <div><strong>{item.label}</strong><span>{item.description}</span></div>
      <div><strong>{formatBytes(item.sizeBytes)}</strong><span>{item.fileCount.toLocaleString()}개 파일</span></div>
    </div>
  );
}
