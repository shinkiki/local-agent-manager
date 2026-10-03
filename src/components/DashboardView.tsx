import { Fragment, useCallback, useEffect, useMemo, useState, type CSSProperties, type MouseEvent, type ReactNode } from "react";
import { formatBytes, formatRelative, formatTokens, sourceName } from "../lib/format";
import { formatRunningElapsed, recentSessionActivity, type RecentSessionActivity } from "../lib/sessionActivity";
import { isWaitingRunStatus } from "../lib/schedulerSnapshot";
import { cumulativeUsage, recentMonthPeriods, weeklyUsageOverview, type CumulativeUsage, type MonthPeriod, type WeeklyUsageRow } from "../lib/usageDashboard";
import { getAccountUsageHistory, getAntigravityPacingUsage } from "../lib/ipc";
import { PROVIDER_IDS } from "../lib/providerIds";
import { sessionKey } from "../lib/sessionKey";
import { useI18n } from "../lib/i18n";
import type { AccountSnapshot, AccountUsageHistory, AppLocale, ChatAttentionSnapshot, ManagerSnapshot, ProviderAccountView, ProviderId, ProviderStatus, ScheduleRecurrence, ScheduleRun, ScheduleRunStatus, ScheduledRequest, SchedulerSnapshot, SessionSummary } from "../types";
import { EmptyState, ProviderMark, SourceBadge } from "./Shared";
import { errorText } from "../lib/errorText";
import { displayPath } from "../lib/displayPath";
import { usageSeriesColor } from "../lib/usageSeriesColor";
import { useEffectiveDark } from "../lib/useDiagramSvg";

import { runtimeText } from "../lib/i18nRuntime";
interface DashboardProps {
  snapshot: ManagerSnapshot;
  scheduler: SchedulerSnapshot | null;
  attention: ChatAttentionSnapshot;
  accounts: AccountSnapshot | null;
  onOpenSession: (session: SessionSummary) => void;
  onOpenSchedules: () => void;
  onConnectCli: (provider: ProviderStatus) => void;
}

/** `useI18n().text`의 모양. 컴포넌트 밖 순수 함수가 문구를 고를 때 넘겨받는다. */
type Text = (ko: string, en: string) => string;

const VISIBLE_SCHEDULES = 7;
const VISIBLE_MODELS = 8;

/**
 * 대시보드가 공급자별로 늘어놓는 칸에 쓰는 짧은 이름. 세션 요약 문구와 주간 추이 범례는
 * 좁은 칸에 셋을 나란히 적어야 해 `sourceName`의 정식 이름(Antigravity)을 쓰지 못한다.
 */
const DASHBOARD_PROVIDER_SHORT_NAMES: Record<ProviderId, string> = {
  claude: "Claude",
  codex: "Codex",
  antigravity: "AG",
  local: "로컬",
};

/** 짧은 이름. "로컬"만 번역이 필요한 낱말이라 화면 언어를 따른다(나머지는 고유명사). */
function dashboardProviderShortName(provider: ProviderId): string {
  return provider === "local" ? runtimeText("로컬", "Local") : DASHBOARD_PROVIDER_SHORT_NAMES[provider];
}

/**
 * 주간 추이 한 주의 전체 세션 수. 최댓값을 잡을 때와 막대를 그릴 때가 따로 세고 있었는데,
 * 공급자가 늘면 한쪽만 고쳐져 막대 높이가 조용히 어긋난다.
 */
function weeklyTotal(week: ManagerSnapshot["dashboard"]["weekly"][number]): number {
  return PROVIDER_IDS.reduce((total, provider) => total + week[provider], 0);
}

/**
 * `intervalMs`마다 현재 시각을 다시 읽는 시계. 스냅샷이 그대로여도 시간이 흐르면 다시
 * 계산해야 하는 값(경과 시간·사용량 창 초기화)에 쓴다. `enabled`를 끄면 시계를 멈추고,
 * 다시 켤 때 멈춰 있던 동안 흐른 시간을 한 번에 따라잡는다.
 */
function useNowTicker(intervalMs: number, enabled = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return undefined;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [enabled, intervalMs]);
  return now;
}

/** 조회 전·실패 시의 Antigravity 자원 목록. 참조를 고정해 계산이 헛돌지 않게 한다. */
const EMPTY_USAGE_RESOURCES: ProviderAccountView[] = [];

/**
 * 계정 스냅샷이 바뀔 때마다 한 번씩 다시 읽는 조회. 스냅샷이 오기 전에는 읽지 않고, 앞선
 * 조회가 늦게 끝나도 화면을 덮어쓰지 않도록 취소 표시로 막는다. 실패는 이전에 읽은 값을
 * 그대로 둔 채 문구만 남겨, 한 번 그려진 그래프가 재조회 실패로 비어 버리지 않게 한다.
 * `load`는 모듈 수준 함수라 참조가 고정된다 — 렌더마다 만든 함수를 넘기면 매번 다시 읽는다.
 */
function useAccountScopedRead<T>(accounts: AccountSnapshot | null, load: () => Promise<T>): { value: T | null; error: string | null } {
  const [value, setValue] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!accounts) return undefined;
    let cancelled = false;
    load()
      .then((read) => {
        if (cancelled) return;
        setValue(read);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(errorText(cause));
      });
    return () => { cancelled = true; };
  }, [accounts, load]);
  return { value, error };
}

/** 계정을 사람이 알아볼 이름. 표시 이름이 없는 계정은 이메일, 그것도 없으면 ID로 부른다. */
function accountLabel(account: ProviderAccountView): string {
  return account.displayName || account.email || account.id;
}

/** 날짜 표기에 쓸 BCP 47 태그. 한국어 화면만 한국식 날짜를 쓰고, 영어·제3언어는 영어식으로 맞춘다. */
function dateLocale(locale: AppLocale): string {
  return locale === "ko" ? "ko-KR" : "en-US";
}

export function DashboardView({ snapshot, scheduler, attention, accounts, onOpenSession, onOpenSchedules, onConnectCli }: DashboardProps) {
  const { dashboard, status } = snapshot;

  return (
    <div className="view-stack">
      <DashboardStatGrid dashboard={dashboard} />

      <section className="provider-strip">
        {status.providers.map((provider) => <ProviderCard provider={provider} onConnect={onConnectCli} key={provider.provider} />)}
      </section>

      <section className="dashboard-grid">
        <AccountUsagePanel accounts={accounts} providers={status.providers} />
        <RecentSessionsPanel recent={dashboard.recent} attentionItems={attention.items} onOpenSession={onOpenSession} />
        <RecurringSchedulesPanel scheduler={scheduler} onOpenSchedules={onOpenSchedules} />
        <TopProjectsPanel topProjects={dashboard.topProjects} />
        <ModelDistributionPanel models={dashboard.models} />
        <WeeklySessionTrendPanel weekly={dashboard.weekly} />
      </section>
    </div>
  );
}

interface DashboardStatCard {
  label: string;
  value: string;
  detail: string;
}

function dashboardStatCards(dashboard: ManagerSnapshot["dashboard"], text: Text): DashboardStatCard[] {
  return [
    {
      label: text("전체 세션", "All sessions"),
      value: dashboard.sessionCount.toLocaleString(),
      detail: PROVIDER_IDS.map((provider) => `${dashboardProviderShortName(provider)} ${dashboard.sessionsBySource[provider]}`).join(" · "),
    },
    {
      label: text("총 토큰", "Total tokens"),
      value: formatTokens(dashboard.tokens.total),
      detail: text("캐시 토큰 포함", "Includes cached tokens"),
    },
    {
      label: text("인덱싱 용량", "Indexed storage"),
      value: formatBytes(dashboard.disk.total),
      detail: text("원본 파일은 읽기 전용", "Source files are read only"),
    },
    {
      label: text("스킬 / 에이전트", "Skills / agents"),
      value: `${dashboard.skillCount} / ${dashboard.agentCount}`,
      detail: text("로컬 정의 자동 탐지", "Automatic local discovery"),
    },
  ];
}

/** 대시보드 상단의 주요 통계 4종 그리드 */
function DashboardStatGrid({ dashboard }: { dashboard: ManagerSnapshot["dashboard"] }) {
  const { text } = useI18n();
  const cards = dashboardStatCards(dashboard, text);
  return (
    <section className="stat-grid">
      {cards.map((card) => (
        <StatCard
          key={card.label}
          label={card.label}
          value={card.value}
          detail={card.detail}
        />
      ))}
    </section>
  );
}

/** 최근 세션 패널. 진행 중 세션 여부에 따라 30초 시계를 켜고 끈다. */
function RecentSessionsPanel({
  recent,
  attentionItems,
  onOpenSession,
}: {
  recent: SessionSummary[];
  attentionItems: ChatAttentionSnapshot["items"];
  onOpenSession: (session: SessionSummary) => void;
}) {
  const { text } = useI18n();
  const recentActivities = useMemo(() => new Map(
    recent.map((session) => [
      sessionKey(session.source, session.id),
      recentSessionActivity(session, attentionItems),
    ]),
  ), [attentionItems, recent]);
  const hasRunningSession = [...recentActivities.values()].some((activity) => activity.status === "running");
  // 진행 중 세션이 하나도 없으면 경과 시간을 다시 그릴 이유가 없어 시계를 멈춘다.
  const elapsedNow = useNowTicker(30_000, hasRunningSession);

  return (
    <DashboardPanel
      title={text("최근 세션", "Recent sessions")}
      detail={text("업데이트 순 · 실행 상태", "Most recently updated · run status")}
      empty={recent.length === 0 ? <EmptyState title={text("세션이 없습니다", "No sessions")} /> : null}
    >
      <div className="recent-list">
        {recent.map((session) => {
          const key = sessionKey(session.source, session.id);
          const activity = recentActivities.get(key)
            ?? { status: "completed", occurredAt: session.updatedAt } satisfies RecentSessionActivity;
          return (
            <button key={key} type="button" onClick={() => onOpenSession(session)}>
              <SourceBadge source={session.source} />
              <span className="recent-title" data-user-content>{session.title}</span>
              <span className="recent-session-meta">
                <SessionStatus activity={activity} nowMs={elapsedNow} />
                <time>{formatRelative(session.updatedAt)}</time>
              </span>
            </button>
          );
        })}
      </div>
    </DashboardPanel>
  );
}

/** 실행 이력을 원래 순서 그대로 일정별로 묶는다. */
function groupScheduleRuns(runs: readonly ScheduleRun[]): Map<string, ScheduleRun[]> {
  const grouped = new Map<string, ScheduleRun[]>();
  for (const run of runs) {
    const scheduleRuns = grouped.get(run.scheduleId) ?? [];
    scheduleRuns.push(run);
    grouped.set(run.scheduleId, scheduleRuns);
  }
  return grouped;
}

/** 반복 자동 요청 일정 현황 패널 */
function RecurringSchedulesPanel({
  scheduler,
  onOpenSchedules,
}: {
  scheduler: SchedulerSnapshot | null;
  onOpenSchedules: () => void;
}) {
  const { text } = useI18n();
  // 활성 일정이 다음 실행 시각 순으로 먼저 오고, 일시정지된 일정은 뒤로 보낸다.
  const sortedSchedules = scheduler
    ? [...scheduler.schedules].sort((left, right) =>
        Number(right.enabled) - Number(left.enabled) || left.nextRunAt - right.nextRunAt)
    : [];
  const enabledCount = sortedSchedules.filter((schedule) => schedule.enabled).length;
  // 일정 행마다 전체 실행 이력을 다시 훑지 않도록 한 번만 일정 ID별로 묶는다. 각 묶음은
  // 원래 runs 순서를 유지하므로 최근 실행과 활성 실행을 고르는 행의 판정은 그대로다.
  const runsBySchedule = useMemo(
    () => groupScheduleRuns(scheduler?.runs ?? []),
    [scheduler?.runs],
  );
  // 개수가 끼는 머리말은 카탈로그 치환으로 못 만든다 — 언어마다 문장 한 벌씩 통째로 둔다(QA #51).
  const scheduleHeading = scheduler
    ? text(
      `${scheduler.paused ? "전체 일시정지됨 · " : ""}활성 ${enabledCount} / 전체 ${sortedSchedules.length} · 다음 실행 순`,
      `${scheduler.paused ? "All paused · " : ""}Active ${enabledCount} / ${sortedSchedules.length} total · by next run`,
    )
    : text("예약 자동 요청 현황", "Scheduled automatic requests");

  return (
    <DashboardPanel
      title={text("반복 일정", "Recurring schedules")}
      detail={scheduleHeading}
      actions={<button className="button" type="button" onClick={onOpenSchedules}>{text("관리", "Manage")}</button>}
      empty={!scheduler ? (
        <EmptyState title={text("반복 일정을 불러오는 중입니다", "Loading recurring schedules")} />
      ) : sortedSchedules.length === 0 ? (
        <EmptyState
          title={text("등록된 반복 일정이 없습니다", "No recurring schedules")}
          detail={text("관리를 눌러 첫 반복 요청을 만드세요.", "Click Manage to create your first recurring request.")}
        />
      ) : null}
    >
      <div className="dashboard-schedule-list">
        {sortedSchedules.slice(0, VISIBLE_SCHEDULES).map((schedule) => (
          <ScheduleOverviewRow
            key={schedule.id}
            schedule={schedule}
            runs={runsBySchedule.get(schedule.id) ?? []}
            onOpen={onOpenSchedules}
          />
        ))}
        {sortedSchedules.length > VISIBLE_SCHEDULES && (
          <button className="dashboard-schedule-more" type="button" onClick={onOpenSchedules}>
            {text(
              `외 ${sortedSchedules.length - VISIBLE_SCHEDULES}개 반복 일정 보기`,
              `Show ${sortedSchedules.length - VISIBLE_SCHEDULES} more recurring schedules`,
            )}
          </button>
        )}
      </div>
    </DashboardPanel>
  );
}

/** 프로젝트 사용 빈도 상위 10건 패널 */
function TopProjectsPanel({ topProjects }: { topProjects: ManagerSnapshot["dashboard"]["topProjects"] }) {
  const { text } = useI18n();
  const maxProject = Math.max(1, ...topProjects.map((project) => project.count));

  return (
    <DashboardPanel
      title={text("프로젝트 Top 10", "Top 10 projects")}
      detail={text("연결된 작업 디렉터리 기준", "By linked working directory")}
      empty={topProjects.length === 0 ? <EmptyState title={text("프로젝트 기록이 없습니다", "No project records")} /> : null}
    >
      <div className="project-list">
        {topProjects.map((project) => (
          <div className="project-row" key={project.path} title={displayPath(project.path)} data-user-content>
            <div><strong>{displayPath(project.name)}</strong><span>{project.count}</span></div>
            <div className="progress"><span style={{ width: `${(project.count / maxProject) * 100}%` }} /></div>
          </div>
        ))}
      </div>
    </DashboardPanel>
  );
}

/** 세션에 기록된 모델 빈도 상위 8종 분포 패널 */
function ModelDistributionPanel({ models }: { models: ManagerSnapshot["dashboard"]["models"] }) {
  const { text } = useI18n();

  return (
    <DashboardPanel
      title={text("모델 분포", "Model distribution")}
      detail={text("세션에 기록된 모델", "Models recorded in sessions")}
      empty={models.length === 0 ? <EmptyState title={text("모델 기록이 없습니다", "No model records")} /> : null}
    >
      <div className="rank-list">
        {models.slice(0, VISIBLE_MODELS).map((model, index) => (
          <div className="rank-row" key={model.model}>
            <span>{index + 1}</span>
            <code title={model.model}>{model.model}</code>
            <strong>{model.count}</strong>
          </div>
        ))}
      </div>
    </DashboardPanel>
  );
}

/** 주간 세션 추이 막대 한 기둥의 표시 모델 */
interface WeeklyColumnView {
  key: number;
  title: string;
  height: number;
  total: number;
  dateLabel: string;
  week: ManagerSnapshot["dashboard"]["weekly"][number];
}

function formatWeekDate(weekStart: number, locale: AppLocale): string {
  return new Date(weekStart).toLocaleDateString(dateLocale(locale), { month: "numeric", day: "numeric" });
}

function weeklyColumnView(
  week: ManagerSnapshot["dashboard"]["weekly"][number],
  maxWeek: number,
  text: Text,
  locale: AppLocale,
): WeeklyColumnView {
  const total = weeklyTotal(week);
  return {
    key: week.weekStart,
    title: text(`${total}개`, `${total}`),
    height: Math.max(4, (total / maxWeek) * 100),
    total,
    dateLabel: formatWeekDate(week.weekStart, locale),
    week,
  };
}

/** 최근 12주 주간 세션 추이 막대 차트 패널 */
function WeeklySessionTrendPanel({ weekly }: { weekly: ManagerSnapshot["dashboard"]["weekly"] }) {
  const { text, locale } = useI18n();
  const maxWeek = Math.max(
    1,
    ...weekly.map(weeklyTotal),
  );

  return (
    <DashboardPanel
      className="panel-wide chart-panel"
      title={text("주간 세션 추이", "Weekly session trend")}
      detail={text("최근 12주 생성·수정된 세션", "Sessions created or updated in the last 12 weeks")}
      actions={(
        <div className="legend">
          {PROVIDER_IDS.map((provider, index) => (
            <Fragment key={provider}>
              {index > 0 && " "}
              <i className={provider} />
              {dashboardProviderShortName(provider)}
            </Fragment>
          ))}
        </div>
      )}
    >
      <div className="weekly-chart">
        {weekly.map((week) => {
          const col = weeklyColumnView(week, maxWeek, text, locale);
          return (
            <div className="week-column" key={col.key} title={col.title}>
              <div className="week-bar" style={{ height: `${col.height}%` }}>
                {col.total > 0 && PROVIDER_IDS.map((provider) => (
                  <span className={`bar-${provider}`} key={provider} style={{ flex: col.week[provider] }} />
                ))}
              </div>
              <span>{col.dateLabel}</span>
            </div>
          );
        })}
      </div>
    </DashboardPanel>
  );
}

/**
 * 계정 소진율 패널. 이 패널만 쓰는 조회(Antigravity 자원·주기 이력)와 1분 시계, 그리고
 * 그 셋을 그래프 계열로 엮는 계산을 대시보드 본문에서 떼어내 여기에 둔다. 대시보드는
 * 스냅샷을 패널에 나눠 주는 배치만 맡는다.
 */
/**
 * 패널이 그리는 데 필요한 것만. 조회 원자료(주기 이력 Map·계정별 소진율 행)는 여기서
 * 새어 나가지 않는다 — 예전에는 그 둘이 그대로 나와 패널이 "세울 계정이 있는가"와
 * "이력이 어느 갈래인가"를 다시 유도했고, 이력 세 갈래는 중첩 삼항 한 줄로 props
 * 자리에 적혀 있었다. 판정은 자료를 쥔 훅에 두고 패널은 배치만 맡는다.
 */
interface AccountUsageData {
  /** 그래프에 세울 계정 계열이 하나도 없는 상태. */
  empty: boolean;
  usageMonths: MonthPeriod[];
  usageSeries: AccountUsageSeries[];
  historyStatus: UsageHistoryStatus;
  /** 이력 조회 실패 문구. 패널 위쪽 배너에 그대로 싣는다. */
  historyError: string | null;
}

/** 계정 스냅샷과 공급자 상태로부터 월별 계정 소진율 차트에 필요한 데이터 일체를 구성한다. */
function useAccountUsageData(
  accounts: AccountSnapshot | null,
  providers: ProviderStatus[],
): AccountUsageData {
  // 7일 창은 초기화 시각이 지나면 재조회 전이라도 0%로 보여야 하므로, 스냅샷이 그대로여도
  // 시간이 흐르면 다시 계산한다. 초기화가 분 단위로 임박한 일은 드물어 1분 주기로 충분하다.
  const usageNow = useNowTicker(60_000);
  const providerOrder = useMemo(() => providers.map((provider) => provider.provider), [providers]);

  // Antigravity는 계정 레지스트리에 없어 계정 스냅샷으로 오지 않지만, 모델군마다 주간
  // 쿼터를 따로 소비하므로 소진율에서 빠지면 이 공급자의 소비가 어디에도 보이지 않는다.
  // 자원 행은 계정 행과 같은 모양이라 그래프는 그대로 쓴다.
  // 조회 실패는 그래프에 이 공급자를 빼는 것으로 끝낸다. 계정 이력 오류와 달리 사용자가
  // 손볼 것이 없고(설치되지 않은 기기가 정상), 계정 소진율은 멀쩡하다.
  const { value: antigravityResources, error: antigravityError } = useAccountScopedRead(accounts, getAntigravityPacingUsage);
  const antigravityUsage = antigravityError !== null ? EMPTY_USAGE_RESOURCES : antigravityResources ?? EMPTY_USAGE_RESOURCES;

  // 주기 이력은 사용량 갱신이 계정 스냅샷에 반영될 때 함께 쌓이므로, 스냅샷이 바뀔 때마다
  // 다시 읽으면 충분하다(스냅샷은 내용이 같으면 같은 참조를 유지한다).
  const { value: usageHistoryRead, error: usageHistoryError } = useAccountScopedRead(accounts, getAccountUsageHistory);
  const usageHistory = useMemo(() => (usageHistoryRead
    ? new Map(usageHistoryRead.accounts.map((entry) => [entry.accountId, entry]))
    : null), [usageHistoryRead]);

  // 지금 값도 지난 주기 이력도 없는 자원은 그래프에 세우지 않는다 — Antigravity를 쓰지
  // 않는 기기에서는 조회가 창 없는 오류 행으로 와서 범례만 늘린다.
  const weeklyUsage = useMemo(() => {
    if (!accounts) return [];
    const resources = antigravityUsage.filter((resource) => (
      resource.usage.windows.length > 0 || (usageHistory?.get(resource.id)?.cycles.length ?? 0) > 0
    ));
    const merged = { ...accounts, accounts: [...accounts.accounts, ...resources] };
    return weeklyUsageOverview(merged, providerOrder, usageNow);
  }, [accounts, antigravityUsage, providerOrder, usageHistory, usageNow]);

  // 그래프의 계열 순서(=색)는 계정 자체에 고정한다. 소진율 순으로 정렬된 weeklyUsage를
  // 그대로 쓰면 달마다 계정의 색이 바뀐다.
  const usageMonths = useMemo(() => recentMonthPeriods(usageNow, USAGE_CHART_MONTHS), [usageNow]);
  const usageSeries = useMemo(
    () => buildAccountUsageSeries(weeklyUsage, providerOrder, usageMonths, usageHistory),
    [providerOrder, usageHistory, usageMonths, weeklyUsage],
  );

  return {
    empty: weeklyUsage.length === 0,
    usageMonths,
    usageSeries,
    // 실패한 재조회는 앞서 읽은 이력을 그대로 둔 채 갈래만 바꾼다 — 막대는 그리되
    // 도움말이 "불러오는 중"으로 남지 않게 하려는 것이다(QA #62).
    historyStatus: usageHistoryError !== null ? "failed" : usageHistory !== null ? "loaded" : "loading",
    historyError: usageHistoryError,
  };
}

function AccountUsagePanel({ accounts, providers }: { accounts: AccountSnapshot | null; providers: ProviderStatus[] }) {
  const { text } = useI18n();
  // 계열색은 배경 밝기에 맞춰 만든다 — 어두운 패널과 밝은 배경이 견디는 명도가 다르다.
  const dark = useEffectiveDark();
  const { empty, usageMonths, usageSeries, historyStatus, historyError } = useAccountUsageData(accounts, providers);

  return (
    <DashboardPanel
      className="panel-wide chart-panel"
      anchor="dashboard.account-usage"
      headingClassName="account-usage-heading"
      title={text("계정 소진율", "Account burn rate")}
      detail={text(
        `최근 ${USAGE_CHART_MONTHS}개월 계정별 제공한도 소비율`,
        `Share of each account's allowance consumed over the last ${USAGE_CHART_MONTHS} months`,
      )}
      actions={usageSeries.length > 0 && (
        <div className="legend account-usage-legend" aria-label={text("계정 범례", "Account legend")}>
          {usageSeries.map(({ row, colorIndex }) => (
            <span key={`${row.account.provider}:${row.account.id}`} title={`${sourceName(row.account.provider)} · ${accountLabel(row.account)}`}>
              <i className="account-usage-swatch" style={{ background: usageSeriesColor(colorIndex, dark) }} />
              {accountLabel(row.account)}
              {row.account.isActive && <em>{text("활성", "Active")}</em>}
            </span>
          ))}
        </div>
      )}
      empty={!accounts ? (
        <EmptyState title={text("계정 정보를 불러오는 중입니다", "Loading account information")} />
      ) : empty ? (
        <EmptyState
          title={text("등록된 계정이 없습니다", "No registered accounts")}
          detail={text(
            "계정 관리에서 Claude·Codex 계정을 추가하면 소진율이 여기에 나타납니다.",
            "Add Claude or Codex accounts in account management and their burn rate appears here.",
          )}
        />
      ) : null}
    >
      {historyError !== null && (
        <p className="account-usage-history-error" role="alert">
          {text("사용량 이력을 읽지 못했습니다:", "Could not read usage history:")} {historyError}
        </p>
      )}
      <AccountUsageChart months={usageMonths} series={usageSeries} historyStatus={historyStatus} />
    </DashboardPanel>
  );
}

/** 정상 종료가 대부분이라 `완료`는 표시하지 않고, 눈여겨볼 상태만 배지로 남긴다. */
function SessionStatus({ activity, nowMs }: { activity: RecentSessionActivity; nowMs: number }) {
  const { text } = useI18n();
  if (activity.status === "completed") return null;
  const label = activity.status === "running"
    ? text(`진행 중 · ${formatRunningElapsed(activity.occurredAt, nowMs)}`, `Running · ${formatRunningElapsed(activity.occurredAt, nowMs)}`)
    : activity.status === "cancelled"
      ? text("취소", "Cancelled")
      : text("실패", "Failed");
  return <span className={`recent-session-status ${activity.status}`}>{label}</span>;
}

function formatShortDate(timestamp: number, locale: AppLocale): string {
  return new Date(timestamp).toLocaleDateString(dateLocale(locale), { year: "numeric", month: "numeric", day: "numeric" });
}

function formatCycles(cycles: number): string {
  return cycles.toFixed(cycles >= 10 ? 0 : 1);
}

/** 그래프가 보여 주는 달 수. */
const USAGE_CHART_MONTHS = 6;
/** y축 눈금(위에서 아래로). 격자 한 칸 25%p와 같다. */
const USAGE_AXIS_TICKS = [100, 75, 50, 25, 0];

interface AccountUsageSeries {
  row: WeeklyUsageRow;
  colorIndex: number;
  /** `months`와 같은 순서. 이력이 아직 없으면 null. */
  months: (CumulativeUsage | null)[];
}

/** 계정마다 색을 고정한 뒤, 표시할 각 달의 누적 소진율을 같은 순서로 붙인다. */
function buildAccountUsageSeries(
  weeklyUsage: WeeklyUsageRow[],
  providerOrder: ProviderAccountView["provider"][],
  months: MonthPeriod[],
  usageHistory: Map<string, AccountUsageHistory> | null,
): AccountUsageSeries[] {
  return [...weeklyUsage]
    .sort((left, right) => (
      providerOrder.indexOf(left.account.provider) - providerOrder.indexOf(right.account.provider)
      || left.account.displayName.localeCompare(right.account.displayName, "ko")
      || left.account.id.localeCompare(right.account.id)
    ))
    .map((row, index) => ({
      row,
      colorIndex: index,
      months: months.map((month) => (usageHistory
        ? cumulativeUsage(usageHistory.get(row.account.id) ?? null, row.windows.map((window) => window.label), month)
        : null)),
    }));
}

/**
 * 이력 조회의 세 갈래. QA #62 — 예전에는 "불러왔는가"의 두 갈래뿐이라, 조회가 실패해
 * 영영 오지 않는 이력도 도움말에서는 "불러오는 중"으로 머물렀다. 같은 화면 위쪽이
 * 실패를 알리는데 막대 도움말만 기다리라고 말하는 자리였다.
 */
type UsageHistoryStatus = "loading" | "loaded" | "failed";

interface AccountUsageChartProps {
  months: MonthPeriod[];
  series: AccountUsageSeries[];
  historyStatus: UsageHistoryStatus;
}

/**
 * 한 달·한 계정 막대의 도움말 본문. 이력 상태에 따라 다섯 갈래인데, 언어마다 문장을 통째로
 * 두어야 하므로 그래프 본문에서 떼어 둔다.
 */
function usageBarDetail(cumulative: CumulativeUsage | null, historyStatus: UsageHistoryStatus, text: Text, locale: AppLocale): string {
  if (historyStatus === "failed") return text("사용량 이력을 읽지 못했습니다", "Could not read usage history");
  if (historyStatus === "loading") return text("이력을 불러오는 중입니다", "Loading history");
  if (cumulative === null) return text("아직 관측한 주기가 없습니다", "No cycles observed yet");
  const from = formatShortDate(cumulative.from, locale);
  if (cumulative.consumedPercent === null) {
    return text(`${from} 관측 시작 이후 자료가 없습니다`, `No data since observation began on ${from}`);
  }
  const windows = cumulative.windows.map((window) => text(
    `${window.label} ${formatCycles(window.budgetCycles)}주기 제공 중 ${formatCycles(window.consumedCycles)}주기분 소비`,
    `${window.label}: ${formatCycles(window.consumedCycles)} of ${formatCycles(window.budgetCycles)} cycles consumed`,
  )).join(" · ");
  return cumulative.truncated ? `${text(`${from}부터`, `Since ${from}`)} · ${windows}` : windows;
}

/** 소진율 막대 한 칸이 그릴 값. 계산은 아래 함수가 맡고 JSX는 이 칸을 받아 그리기만 한다. */
interface AccountUsageBarView {
  key: string;
  className: string;
  style: CSSProperties;
  /** 말풍선 본문이자 `data-detail` 값. */
  title: string;
  ariaLabel: string;
}

/**
 * 한 달·한 계정 막대의 높이·색과 두 벌의 설명 문구를 함께 만든다. 이 일곱 갈래(값 없음
 * 판정, 높이 상한, 빗금 자리, 계열색, 이번 달 표시, 말풍선 본문, 스크린리더 문구)가
 * 그래프 본문의 이중 map 안에 펼쳐져 있어 기둥을 그리는 구조가 그 계산에 묻혀 있었다.
 */
function accountUsageBarView({ entry, monthIndex, month, current, historyStatus, dark, text, locale }: {
  entry: AccountUsageSeries;
  monthIndex: number;
  month: MonthPeriod;
  /** 진행 중인 달. 소진율이 "지금까지" 값임을 말풍선에 덧붙인다. */
  current: boolean;
  historyStatus: UsageHistoryStatus;
  dark: boolean;
  text: Text;
  locale: AppLocale;
}): AccountUsageBarView {
  const { row, colorIndex, months: values } = entry;
  const account = row.account;
  const name = accountLabel(account);
  const cumulative = values[monthIndex] ?? null;
  const percent = cumulative?.consumedPercent ?? null;
  const label = percent !== null ? `${Math.round(percent)}%` : "—";
  const currentNote = current ? text(" (이번 달, 지금까지)", " (this month, so far)") : "";
  const detail = usageBarDetail(cumulative, historyStatus, text, locale);
  return {
    key: `${account.provider}:${account.id}`,
    className: `week-bar account-usage-bar${percent === null ? " empty" : ""}`,
    // 값이 없는 달은 빗금 자리로 남겨야 해서 색을 얹지 않는다.
    style: percent === null
      ? { height: "0%" }
      : { background: usageSeriesColor(colorIndex, dark), height: `${Math.min(100, percent)}%` },
    title: `${month.label} · ${name}\n${text(`소진율 ${label}`, `Burn rate ${label}`)}${currentNote}\n${detail}`,
    ariaLabel: text(`${month.label} ${name} 소진율 ${label}`, `${month.label} ${name} burn rate ${label}`),
  };
}

/**
 * 주간 세션 추이와 같은 기둥 그래프. 달마다 기둥 하나, 그 안에 계정별 막대가 나란히
 * 서고 높이가 그 달의 소진율(0~100%)이다. 격자 한 칸이 25%p. 관측 전이라 계산할 수
 * 없는 달은 바닥의 빗금 자리로 남겨 0%와 구분하고, 이번 달은 진행 중이므로 지금까지
 * 준 제공량 대비로 계산돼 있다. 값은 도움말로 읽는데, 브라우저 기본 `title`은 1초 가까이
 * 기다려야 떠서 막대를 훑는 동안에는 쓸모가 없다. 그래서 마우스가 닿는 즉시 뜨는 말풍선을
 * 직접 그린다. 상세 본문은 `data-detail`에도 남겨 두어 도움말 없이도 값을 확인할 수 있다.
 */
function AccountUsageChart({ months, series, historyStatus }: AccountUsageChartProps) {
  const { text, locale } = useI18n();
  const dark = useEffectiveDark();
  const currentKey = months[months.length - 1]?.key;
  const { tooltip, hide: hideTooltip, follow: followTooltip } = useUsageTooltip();
  return (
    <figure className="account-usage-figure" onMouseLeave={hideTooltip}>
      <div
        className="weekly-chart account-usage-chart"
        role="img"
        aria-label={text(
          `최근 ${months.length}개월 계정별 소진율. y축은 그 달 공급자가 준 주기별 제공량 대비 소비율(%)`,
          `Account burn rate over the last ${months.length} months. The y-axis is the share (%) of that month's per-cycle allowance consumed`,
        )}
      >
        {/* 축 눈금은 데이터 기둥과 같은 week-column 구조로 두어, 위 여백·아래 라벨 높이가
            달라져도 0%·100%가 막대 영역의 바닥·천장에 그대로 맞는다. */}
        <div className="week-column account-usage-axis-column" aria-hidden="true">
          <div className="account-usage-axis">
            {USAGE_AXIS_TICKS.map((tick) => <span key={tick}>{tick}%</span>)}
          </div>
          <span className="account-usage-axis-title">{text("소진율", "Burn rate")}</span>
          {/* 달 라벨과 같은 높이의 빈 칸. 이것이 있어야 눈금 바닥이 막대 바닥과 맞는다. */}
          <span>{"\u00a0"}</span>
        </div>
      {months.map((month, monthIndex) => (
        <div className="week-column" key={month.key}>
          <div className="account-usage-column">
            {series.map((entry) => {
              const bar = accountUsageBarView({
                entry,
                monthIndex,
                month,
                current: month.key === currentKey,
                historyStatus,
                dark,
                text,
                locale,
              });
              return (
                <div
                  className={bar.className}
                  style={bar.style}
                  key={bar.key}
                  data-detail={bar.title}
                  role="img"
                  aria-label={bar.ariaLabel}
                  {...followTooltip(bar.title)}
                />
              );
            })}
          </div>
          <span>{month.label}</span>
        </div>
      ))}
      </div>
      {tooltip && (
        <div
          className={`chart-tooltip${tooltip.below ? " below" : ""}`}
          role="presentation"
          style={{ left: tooltip.x, top: tooltip.y }}
        >{tooltip.detail}</div>
      )}
    </figure>
  );
}

/** 말풍선이 화면 밖으로 나가지 않을 만큼만 잡아 두는 폭·여백(px). `.chart-tooltip`과 같아야 한다. */
const TOOLTIP_HALF_WIDTH = 130;
const TOOLTIP_MARGIN = 8;
/** 위로 띄울 때 필요한 높이의 어림값. 이보다 위가 좁으면 커서 아래로 뒤집는다. */
const TOOLTIP_FLIP_HEIGHT = 110;

interface UsageTooltip {
  detail: string;
  /** 뷰포트 기준 좌표. 말풍선은 `position: fixed`라 그대로 쓴다. */
  x: number;
  y: number;
  /** 위쪽 자리가 모자라 커서 아래로 뒤집은 경우. */
  below: boolean;
}

/** 커서 바로 위에 붙이되, 화면 끝에서는 창 안으로 밀어 넣거나 아래로 뒤집는다. */
function tooltipAt(event: { clientX: number; clientY: number }, detail: string): UsageTooltip {
  const limit = Math.max(TOOLTIP_HALF_WIDTH + TOOLTIP_MARGIN, window.innerWidth - TOOLTIP_HALF_WIDTH - TOOLTIP_MARGIN);
  const below = event.clientY - TOOLTIP_MARGIN < TOOLTIP_FLIP_HEIGHT;
  return {
    detail,
    x: Math.min(limit, Math.max(TOOLTIP_HALF_WIDTH + TOOLTIP_MARGIN, event.clientX)),
    y: below ? event.clientY + TOOLTIP_MARGIN * 2 : event.clientY - TOOLTIP_MARGIN,
    below,
  };
}

/** 커서를 따라다니는 말풍선에 필요한 마우스 처리. 막대마다 같은 모양으로 붙는다. */
interface UsageTooltipHandlers {
  onMouseEnter: (event: MouseEvent<HTMLElement>) => void;
  onMouseMove: (event: MouseEvent<HTMLElement>) => void;
  onMouseLeave: () => void;
}

/**
 * 말풍선 하나를 여러 자리에서 띄우고 지운다. `follow`가 돌려주는 핸들러 묶음을 요소에
 * 펼쳐 넣으면 되므로, 막대마다 진입·이동·이탈 세 줄을 같은 모양으로 적지 않아도 된다.
 */
function useUsageTooltip(): { tooltip: UsageTooltip | null; hide: () => void; follow: (detail: string) => UsageTooltipHandlers } {
  const [tooltip, setTooltip] = useState<UsageTooltip | null>(null);
  const hide = useCallback(() => setTooltip(null), []);
  const follow = useCallback((detail: string): UsageTooltipHandlers => {
    const track = (event: MouseEvent<HTMLElement>) => setTooltip(tooltipAt(event, detail));
    return { onMouseEnter: track, onMouseMove: track, onMouseLeave: hide };
  }, [hide]);
  return { tooltip, hide, follow };
}

function providerCliSummary(provider: ProviderStatus, text: Text): string {
  if (provider.cli.detected) return text("CLI 연결됨", "CLI connected");
  if (provider.history.detected) return text("CLI 미연결 · 클릭해 연결", "CLI not connected · click to connect");
  return text("CLI 미탐지", "CLI not detected");
}

function ProviderCard({ provider, onConnect }: { provider: ProviderStatus; onConnect: (provider: ProviderStatus) => void }) {
  const { text } = useI18n();
  const content = <>
    {/* 색 점 대신 공급자 표식이 선다 — 이름 옆에서 어느 공급자인지 색만으로 읽던 자리라
        표식이 그 일을 그대로 대신한다. 식별색은 범례·막대에 남는다. */}
    <ProviderMark provider={provider.provider} size={18} />
    <div className="provider-status-copy">
      <strong>{provider.displayName}</strong>
      <span>{providerCliSummary(provider, text)}</span>
    </div>
    <span className={provider.history.detected ? "health ready" : "health muted"}>
      {provider.history.detected ? text("채팅 탐지", "Conversation discovery") : text("데이터 없음", "No data")}
    </span>
  </>;
  return (
    <button
      className="provider-status provider-status-action"
      type="button"
      onClick={() => onConnect(provider)}
      // 로컬 공급자는 CLI가 없다. 여는 것은 연결 설정이므로 이름에서 CLI를 뺀다.
      aria-label={provider.provider === "local"
        ? text(`${provider.displayName} 연결 관리 열기`, `Open ${provider.displayName} connection management`)
        : text(`${provider.displayName} CLI 연결 관리 열기`, `Open ${provider.displayName} CLI connection management`)}
    >
      {content}
    </button>
  );
}

function ScheduleOverviewRow({ schedule, runs, onOpen }: { schedule: ScheduledRequest; runs: ScheduleRun[]; onOpen: () => void }) {
  const { text } = useI18n();
  const { status, label: statusLabel } = scheduleRunStatus(schedule, runs, text);
  // 워크플로 반복 요청은 공급자 채팅을 띄우지 않으므로 공급자 배지를 걸지 않는다.
  const workflow = schedule.workflow ?? null;
  return (
    <button className="dashboard-schedule-row" type="button" onClick={onOpen} title={workflow ? `${workflow.workflowId} v${workflow.approvedVersion}` : schedule.prompt}>
      <div className="dashboard-schedule-top">
        {workflow ? <span className="source-badge source-workflow">{text("워크플로", "Workflow")}</span> : <SourceBadge source={schedule.source} />}
        <span className="dashboard-schedule-name">{schedule.name}</span>
        <span className={`schedule-status ${status}`}>{statusLabel}</span>
      </div>
      <div className="dashboard-schedule-sub">
        <span>{recurrenceLabel(schedule.recurrence, text)}</span>
        <span>{schedule.enabled ? text(`다음 ${formatRelative(schedule.nextRunAt)}`, `Next ${formatRelative(schedule.nextRunAt)}`) : text("다음 –", "Next –")}</span>
        {schedule.lastRunAt !== null && <span>{text(`지난 실행 ${formatRelative(schedule.lastRunAt)}`, `Last run ${formatRelative(schedule.lastRunAt)}`)}</span>}
      </div>
    </button>
  );
}

/** 일정 행의 상태 클래스와 표시 문구가 같은 실행 판정에서 나오도록 한 자리에서 결정한다. */
function scheduleRunStatus(schedule: ScheduledRequest, runs: ScheduleRun[], text: Text) {
  if (!schedule.enabled) return { status: "paused", label: text("일시정지", "Paused") };

  const activeRun = runs.find((run) => run.status === "running" || isWaitingRunStatus(run.status));
  if (activeRun) {
    return {
      status: isWaitingRunStatus(activeRun.status) ? activeRun.status : "running",
      label: runStatusLabel(activeRun.status, text),
    };
  }
  if (schedule.manualRunRequestedAt) {
    return { status: "requested", label: text("실행 요청됨", "Run requested") };
  }

  const lastRun = runs[0];
  return lastRun
    ? { status: lastRun.status, label: runStatusLabel(lastRun.status, text) }
    : { status: "idle", label: text("대기", "Waiting") };
}

/** 같은 요일의 한국어·영어 이름이 서로 다른 인덱스로 어긋나지 않게 한 줄로 묶는다. */
const WEEKDAY_LABELS = [
  { ko: "일", en: "Sun" },
  { ko: "월", en: "Mon" },
  { ko: "화", en: "Tue" },
  { ko: "수", en: "Wed" },
  { ko: "목", en: "Thu" },
  { ko: "금", en: "Fri" },
  { ko: "토", en: "Sat" },
] as const;

function recurrenceLabel(recurrence: ScheduleRecurrence, text: Text): string {
  const time = `${String(recurrence.hour).padStart(2, "0")}:${String(recurrence.minute).padStart(2, "0")}`;
  switch (recurrence.frequency) {
    case "hourly": return recurrence.interval === 1 ? text("매시간", "Every hour") : text(`매 ${recurrence.interval}시간`, `Every ${recurrence.interval} hours`);
    case "daily": return text(`매일 ${time}`, `Daily at ${time}`);
    case "weekdays": return text(`평일 ${time}`, `Weekdays at ${time}`);
    case "weekly": {
      const weekday = WEEKDAY_LABELS[recurrence.weekday];
      return text(
        `매주 ${weekday?.ko ?? "?"}요일 ${time}`,
        `Every ${weekday?.en ?? "?"} at ${time}`,
      );
    }
    case "cron": return `Cron ${recurrence.cron ?? "–"}`;
    case "auto": return text("자동 · 가드 창 간격", "Auto · guard window interval");
  }
}

/** 반복 일정의 각 실행 상태별 한국어·영어 대응표 */
const SCHEDULE_RUN_STATUS_LABELS: Record<ScheduleRunStatus, { ko: string; en: string }> = {
  completed: { ko: "완료", en: "Completed" },
  failed: { ko: "실패", en: "Failed" },
  cancelled: { ko: "취소됨", en: "Cancelled" },
  skipped: { ko: "건너뜀", en: "Skipped" },
  waitingForAccount: { ko: "계정 준비 대기", en: "Waiting for account" },
  waitingForUsage: { ko: "사용량 복구 대기", en: "Waiting for usage to recover" },
  running: { ko: "실행 중", en: "Running" },
};

function runStatusLabel(status: ScheduleRunStatus, text: Text): string {
  const label = SCHEDULE_RUN_STATUS_LABELS[status] ?? SCHEDULE_RUN_STATUS_LABELS.running;
  return text(label.ko, label.en);
}

/**
 * 대시보드 패널 하나의 겉틀. 여섯 패널이 모두 같은 뼈대를 쓴다 — 제목과 설명, 그 오른쪽에
 * 서는 조작 버튼이나 범례(`actions`), 그리고 보여 줄 것이 없을 때 본문 대신 서는
 * 안내(`empty`). 겉틀과 그 갈래를 패널마다 다시 쓰면 비었을 때의 처리가 패널마다
 * 어긋나기 쉬워 여기 한 곳에 둔다. `empty`가 null이 아니면 본문은 그리지 않는다.
 */
function DashboardPanel({ title, detail, className, headingClassName, anchor, actions, empty = null, children }: {
  title: ReactNode;
  detail: ReactNode;
  /** `panel`에 덧붙일 클래스. 넓은 차트 패널이 쓴다. */
  className?: string;
  headingClassName?: string;
  anchor?: string;
  actions?: ReactNode;
  empty?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <article className={className ? `panel ${className}` : "panel"} data-ui-anchor={anchor}>
      <div className={headingClassName ? `panel-heading ${headingClassName}` : "panel-heading"}>
        <div>
          <h2>{title}</h2>
          <p>{detail}</p>
        </div>
        {actions}
      </div>
      {empty ?? children}
    </article>
  );
}

function StatCard({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <article className="stat-card">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </article>
  );
}
