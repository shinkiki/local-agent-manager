import { Database, KeyRound } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { formatBytes } from "../lib/format";
import { useI18n, type UiText } from "../lib/i18n";
import { getStorageOverview } from "../lib/ipc";
import { usePoll } from "../lib/poll";
import type { TabRequest } from "../lib/uiGuide";
import type { StorageOverview, StorageUsageItem } from "../types";
import { ErrorBanner, LoadingState } from "./Shared";
import { errorText } from "../lib/errorText";
import { SessionCleanupCard } from "./SessionCleanupCard";
import { SettingsSubTabPanel, SettingsSubTabs, type SettingsSubTab } from "./SettingsSubTabs";
import { StorageSecretsTab } from "./StorageSecretsTab";

export type StorageTabId = "data" | "secrets";

// 설정·애드온 화면과 같은 중메뉴. 용량·정리(데이터)와 채팅 비밀값(비밀정보)은 서로 다른
// 저장 위치를 다루므로 한 화면에 쌓지 않고 탭으로 나눈다.
const storageTabs: readonly SettingsSubTab<StorageTabId>[] = [
  { id: "data", icon: Database, ko: "데이터", en: "Data", anchor: "storage.tab.data" },
  { id: "secrets", icon: KeyRound, ko: "비밀정보", en: "Secrets", anchor: "storage.tab.secrets" },
];

/** 측정 시각 표기. 저장소 화면은 같은 날 안에서 30초마다 다시 재므로 시:분:초만 적는다. */
const MEASURED_AT_FORMATTER = new Intl.DateTimeFormat("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

/**
 * 저장소 측정의 폴링과 마지막 성공값을 한 벌로 관리한다. 갱신 실패를 다시 던지는 것은
 * `usePoll`의 기존 실패 처리 계약을 지키면서, 화면에는 마지막 성공값과 오류를 함께 남기기
 * 위해서다(QA #47).
 */
function useStorageMeasurement() {
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

  return { measured, error };
}

/**
 * 저장소 측정 상태 안내 문구. 갱신 실패 여부에 따라 stale 스타일과 마지막 측정 시각 안내를 표시한다.
 */
function StorageRefreshStatus({ stale, measuredAtText }: { stale: boolean; measuredAtText: string }) {
  const { text } = useI18n();
  return (
    <p className={`settings-storage-note storage-refresh-status${stale ? " is-stale" : ""}`} role="status" data-ui-anchor="storage.refresh-status">
      {stale
        ? text(`갱신 실패 · 아래 수치는 마지막 측정 시각 ${measuredAtText} 기준입니다`, `Refresh failed · figures below are from the last measurement at ${measuredAtText}`)
        : text(`마지막 측정 시각 ${measuredAtText} · 30초마다 다시 잽니다`, `Last measured at ${measuredAtText} · re-measured every 30 seconds`)}
    </p>
  );
}

/**
 * 저장소 화면. `active`는 App이 이 화면을 보이고 있는지다 — 세션 자동정리 카드가 탭 진입마다
 * 다시 읽고, 비밀정보 탭이 보일 때만 폴링하는 데 쓴다(설정 화면이 넘기는 방식과 같다).
 */
export function StorageView({ active = true, tabRequest = null }: { active?: boolean; tabRequest?: TabRequest<StorageTabId> | null }) {
  const { text } = useI18n();
  const [tab, setTab] = useState<StorageTabId>("data");
  // AIA가 저장된 비밀값 카드를 가리키려면 비밀정보 탭이 먼저 열려야 한다(C17-4).
  useEffect(() => {
    if (tabRequest) setTab(tabRequest.tab);
  }, [tabRequest]);

  // `.storage-view`는 사용량이 읽힌 뒤의 지표 묶음에만 붙는다(E2E가 "첫 조회 실패면 .storage-view가
  // 없다"와 ".storage-view의 첫 자식이 오류 배너"를 그 이름으로 본다). 바깥 껍데기는 다른 이름을 쓴다.
  return (
    <div className="settings-subtab-view storage-screen">
      <SettingsSubTabs idPrefix="storage" tabs={storageTabs} value={tab} onChange={setTab} label={text("저장소 메뉴", "Storage menu")} />
      <SettingsSubTabPanel idPrefix="storage" id="data" active={tab === "data"}>
        <StorageDataTab active={active && tab === "data"} />
      </SettingsSubTabPanel>
      <SettingsSubTabPanel idPrefix="storage" id="secrets" active={tab === "secrets"}>
        <StorageSecretsTab active={active && tab === "secrets"} />
      </SettingsSubTabPanel>
    </div>
  );
}

/**
 * 데이터 탭 — 저장소 사용량 상태줄·통계·상세와 그 아래 세션 자동정리 카드. 사용량 측정이
 * 아직이거나 실패해도 정리 카드는 그대로 선다 — 둘은 서로 다른 조회다.
 */
function StorageDataTab({ active }: { active: boolean }) {
  return (
    <div className="view-stack storage-data">
      <StorageUsageSection />
      <SessionCleanupCard active={active} />
    </div>
  );
}

function StorageUsageSection() {
  const { text } = useI18n();
  const { measured, error } = useStorageMeasurement();

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
      <StorageRefreshStatus stale={stale} measuredAtText={measuredAtText} />
      <StorageStats overview={overview} stale={stale} measuredAtText={measuredAtText} />
      <StorageBreakdownGrid overview={overview} />
    </div>
  );
}

interface StorageStatMetric {
  id: string;
  label: string;
  value: string;
  detail: string;
}

/** 저장소 개요로부터 상단 네 통계 카드의 지표 목록을 조립한다. */
function storageOverviewMetrics(overview: StorageOverview, text: UiText): StorageStatMetric[] {
  return [
    {
      id: "total",
      label: text("관리 대상 전체", "All managed data"),
      value: formatBytes(overview.totalBytes),
      detail: text("대화 원본 + Agent Manager 상태", "Provider transcripts + Agent Manager state"),
    },
    {
      id: "source",
      label: text("공급자 대화 원본", "Provider transcripts"),
      value: formatBytes(overview.sourceTotalBytes),
      detail: text("원본 파일은 읽기 전용", "Original files are read-only"),
    },
    {
      id: "manager",
      label: text("Agent Manager 상태", "Agent Manager state"),
      value: formatBytes(overview.managerTotalBytes),
      detail: text("보완 응답과 반복 요청 포함", "Includes supplements and recurring requests"),
    },
    {
      id: "supplements",
      label: text("보완 저장 결과", "Stored supplements"),
      value: text(`${overview.supplements.turnCount.toLocaleString()}건`, `${overview.supplements.turnCount.toLocaleString()} turns`),
      detail: text(
        `${overview.supplements.sessionCount.toLocaleString()}개 세션 · ${formatBytes(overview.supplements.sizeBytes)}`,
        `${overview.supplements.sessionCount.toLocaleString()} sessions · ${formatBytes(overview.supplements.sizeBytes)}`,
      ),
    },
  ];
}

/** 저장소 개요를 화면 상단의 네 통계 카드로 조립한다. */
function StorageStats({ overview, stale, measuredAtText }: { overview: StorageOverview; stale: boolean; measuredAtText: string }) {
  const { text } = useI18n();
  const stats = storageOverviewMetrics(overview, text);

  return (
    <section className={`stat-grid${stale ? " is-stale" : ""}`}>
      {stats.map(({ id, ...stat }) => (
        <StorageStat {...stat} stale={stale} measuredAtText={measuredAtText} key={id} />
      ))}
    </section>
  );
}

function StorageStat({ label, value, detail, stale, measuredAtText }: { label: string; value: string; detail: string; stale: boolean; measuredAtText: string }) {
  const { text } = useI18n();
  // 낡은 값은 카드 자체에도 측정 시각을 달아, 배너를 지나쳐도 어느 시점 값인지 읽힌다.
  const shown = stale ? text(`${measuredAtText} 측정 · 갱신 실패`, `Measured ${measuredAtText} · refresh failed`) : detail;
  return <article className={`stat-card${stale ? " is-stale" : ""}`} title={stale ? detail : undefined}><span>{label}</span><strong>{value}</strong><small>{shown}</small></article>;
}

/** 공급자 대화 원본과 Agent Manager 보완 저장소 상세 패널을 격자로 배치한다. */
function StorageBreakdownGrid({ overview }: { overview: StorageOverview }) {
  const { text } = useI18n();
  return (
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
  );
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
