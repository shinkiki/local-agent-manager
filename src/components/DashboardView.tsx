import { useEffect, useMemo, useState, type ReactNode } from "react";
import { formatBytes, formatRelative, formatTokens, sourceName } from "../lib/format";
import { formatRunningElapsed, recentSessionActivity, type RecentSessionActivity } from "../lib/sessionActivity";
import { isWaitingRunStatus } from "../lib/schedulerSnapshot";
import { cumulativeUsage, recentMonthPeriods, weeklyUsageOverview, type CumulativeUsage, type MonthPeriod, type WeeklyUsageRow } from "../lib/usageDashboard";
import { getAccountUsageHistory, getAntigravityPacingUsage } from "../lib/ipc";
import { useI18n } from "../lib/i18n";
import type { AccountSnapshot, AccountUsageHistory, AppLocale, ChatAttentionSnapshot, ManagerSnapshot, ProviderAccountView, ProviderStatus, ScheduleRecurrence, ScheduleRun, ScheduledRequest, SchedulerSnapshot, SessionSummary } from "../types";
import { EmptyState, SourceBadge } from "./Shared";
import { errorText } from "../lib/errorText";

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

/** 계정을 사람이 알아볼 이름. 표시 이름이 없는 계정은 이메일, 그것도 없으면 ID로 부른다. */
function accountLabel(account: ProviderAccountView): string {
  return account.displayName || account.email || account.id;
}

/** 날짜 표기에 쓸 BCP 47 태그. 한국어 화면만 한국식 날짜를 쓰고, 영어·제3언어는 영어식으로 맞춘다. */
function dateLocale(locale: AppLocale): string {
  return locale === "ko" ? "ko-KR" : "en-US";
}

export function DashboardView({ snapshot, scheduler, attention, accounts, onOpenSession, onOpenSchedules, onConnectCli }: DashboardProps) {
  const { text, locale } = useI18n();
  const { dashboard, status } = snapshot;
  const maxWeek = Math.max(
    1,
    ...dashboard.weekly.map((week) => week.claude + week.codex + week.antigravity),
  );
  const maxProject = Math.max(1, ...dashboard.topProjects.map((project) => project.count));
  // 활성 일정이 다음 실행 시각 순으로 먼저 오고, 일시정지된 일정은 뒤로 보낸다.
  const sortedSchedules = scheduler
    ? [...scheduler.schedules].sort((left, right) =>
        Number(right.enabled) - Number(left.enabled) || left.nextRunAt - right.nextRunAt)
    : [];
  const enabledCount = sortedSchedules.filter((schedule) => schedule.enabled).length;
  const recentActivities = useMemo(() => new Map(
    dashboard.recent.map((session) => [
      `${session.source}:${session.id}`,
      recentSessionActivity(session, attention.items),
    ]),
  ), [attention.items, dashboard.recent]);
  const hasRunningSession = [...recentActivities.values()].some((activity) => activity.status === "running");
  // 진행 중 세션이 하나도 없으면 경과 시간을 다시 그릴 이유가 없어 시계를 멈춘다.
  const elapsedNow = useNowTicker(30_000, hasRunningSession);
  // 개수가 끼는 머리말은 카탈로그 치환으로 못 만든다 — 언어마다 문장 한 벌씩 통째로 둔다(QA #51).
  const scheduleHeading = scheduler
    ? text(
      `${scheduler.paused ? "전체 일시정지됨 · " : ""}활성 ${enabledCount} / 전체 ${sortedSchedules.length} · 다음 실행 순`,
      `${scheduler.paused ? "All paused · " : ""}Active ${enabledCount} / ${sortedSchedules.length} total · by next run`,
    )
    : text("예약 자동 요청 현황", "Scheduled automatic requests");
  return (
    <div className="view-stack">
      <section className="stat-grid">
        <StatCard
          label={text("전체 세션", "All sessions")}
          value={dashboard.sessionCount.toLocaleString()}
          detail={`Claude ${dashboard.sessionsBySource.claude} · Codex ${dashboard.sessionsBySource.codex} · AG ${dashboard.sessionsBySource.antigravity}`}
        />
        <StatCard
          label={text("총 토큰", "Total tokens")}
          value={formatTokens(dashboard.tokens.total)}
          detail={text("캐시 토큰 포함", "Includes cached tokens")}
        />
        <StatCard
          label={text("인덱싱 용량", "Indexed storage")}
          value={formatBytes(dashboard.disk.total)}
          detail={text("원본 파일은 읽기 전용", "Source files are read only")}
        />
        <StatCard
          label={text("스킬 / 에이전트", "Skills / agents")}
          value={`${dashboard.skillCount} / ${dashboard.agentCount}`}
          detail={text("로컬 정의 자동 탐지", "Automatic local discovery")}
        />
      </section>

      <section className="provider-strip">
        {status.providers.map((provider) => <ProviderCard provider={provider} onConnect={onConnectCli} key={provider.provider} />)}
      </section>

      <section className="dashboard-grid">
        <AccountUsagePanel accounts={accounts} providers={status.providers} />

        <article className="panel">
          <PanelHeading title={text("최근 세션", "Recent sessions")} detail={text("업데이트 순 · 실행 상태", "Most recently updated · run status")} />
          {dashboard.recent.length === 0 ? (
            <EmptyState title={text("세션이 없습니다", "No sessions")} />
          ) : (
            <div className="recent-list">
              {dashboard.recent.map((session) => {
                const activity = recentActivities.get(`${session.source}:${session.id}`)
                  ?? { status: "completed", occurredAt: session.updatedAt } satisfies RecentSessionActivity;
                return (
                  <button key={`${session.source}:${session.id}`} type="button" onClick={() => onOpenSession(session)}>
                    <SourceBadge source={session.source} />
                    <span className="recent-title">{session.title}</span>
                    <span className="recent-session-meta">
                      <SessionStatus activity={activity} nowMs={elapsedNow} />
                      <time>{formatRelative(session.updatedAt)}</time>
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </article>

        <article className="panel">
          <PanelHeading title={text("반복 일정", "Recurring schedules")} detail={scheduleHeading}>
            <button className="button" type="button" onClick={onOpenSchedules}>{text("관리", "Manage")}</button>
          </PanelHeading>
          {!scheduler ? (
            <EmptyState title={text("반복 일정을 불러오는 중입니다", "Loading recurring schedules")} />
          ) : sortedSchedules.length === 0 ? (
            <EmptyState
              title={text("등록된 반복 일정이 없습니다", "No recurring schedules")}
              detail={text("관리를 눌러 첫 반복 요청을 만드세요.", "Click Manage to create your first recurring request.")}
            />
          ) : (
            <div className="dashboard-schedule-list">
              {sortedSchedules.slice(0, VISIBLE_SCHEDULES).map((schedule) => (
                <ScheduleOverviewRow
                  key={schedule.id}
                  schedule={schedule}
                  runs={scheduler.runs.filter((run) => run.scheduleId === schedule.id)}
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
          )}
        </article>

        <article className="panel">
          <PanelHeading title={text("프로젝트 Top 10", "Top 10 projects")} detail={text("연결된 작업 디렉터리 기준", "By linked working directory")} />
          {dashboard.topProjects.length === 0 ? (
            <EmptyState title={text("프로젝트 기록이 없습니다", "No project records")} />
          ) : (
            <div className="project-list">
              {dashboard.topProjects.map((project) => (
                <div className="project-row" key={project.path} title={project.path}>
                  <div><strong>{project.name}</strong><span>{project.count}</span></div>
                  <div className="progress"><span style={{ width: `${(project.count / maxProject) * 100}%` }} /></div>
                </div>
              ))}
            </div>
          )}
        </article>

        <article className="panel">
          <PanelHeading title={text("모델 분포", "Model distribution")} detail={text("세션에 기록된 모델", "Models recorded in sessions")} />
          {dashboard.models.length === 0 ? (
            <EmptyState title={text("모델 기록이 없습니다", "No model records")} />
          ) : (
            <div className="rank-list">
              {dashboard.models.slice(0, 8).map((model, index) => (
                <div className="rank-row" key={model.model}>
                  <span>{index + 1}</span>
                  <code title={model.model}>{model.model}</code>
                  <strong>{model.count}</strong>
                </div>
              ))}
            </div>
          )}
        </article>

        <article className="panel panel-wide chart-panel">
          <PanelHeading title={text("주간 세션 추이", "Weekly session trend")} detail={text("최근 12주 생성·수정된 세션", "Sessions created or updated in the last 12 weeks")}>
            <div className="legend"><i className="claude" />Claude <i className="codex" />Codex <i className="antigravity" />AG</div>
          </PanelHeading>
          <div className="weekly-chart">
            {dashboard.weekly.map((week) => {
              const total = week.claude + week.codex + week.antigravity;
              const height = Math.max(4, (total / maxWeek) * 100);
              return (
                <div className="week-column" key={week.weekStart} title={text(`${total}개`, `${total}`)}>
                  <div className="week-bar" style={{ height: `${height}%` }}>
                    {total > 0 && (
                      <>
                        <span className="bar-claude" style={{ flex: week.claude }} />
                        <span className="bar-codex" style={{ flex: week.codex }} />
                        <span className="bar-antigravity" style={{ flex: week.antigravity }} />
                      </>
                    )}
                  </div>
                  <span>{new Date(week.weekStart).toLocaleDateString(dateLocale(locale), { month: "numeric", day: "numeric" })}</span>
                </div>
              );
            })}
          </div>
        </article>
      </section>
    </div>
  );
}

/**
 * 계정 소진율 패널. 이 패널만 쓰는 조회(Antigravity 자원·주기 이력)와 1분 시계, 그리고
 * 그 셋을 그래프 계열로 엮는 계산을 대시보드 본문에서 떼어내 여기에 둔다. 대시보드는
 * 스냅샷을 패널에 나눠 주는 배치만 맡는다.
 */
function AccountUsagePanel({ accounts, providers }: { accounts: AccountSnapshot | null; providers: ProviderStatus[] }) {
  const { text } = useI18n();
  // 7일 창은 초기화 시각이 지나면 재조회 전이라도 0%로 보여야 하므로, 스냅샷이 그대로여도
  // 시간이 흐르면 다시 계산한다. 초기화가 분 단위로 임박한 일은 드물어 1분 주기로 충분하다.
  const usageNow = useNowTicker(60_000);
  const providerOrder = useMemo(() => providers.map((provider) => provider.provider), [providers]);

  // Antigravity는 계정 레지스트리에 없어 계정 스냅샷으로 오지 않지만, 모델군마다 주간
  // 쿼터를 따로 소비하므로 소진율에서 빠지면 이 공급자의 소비가 어디에도 보이지 않는다.
  // 자원 행은 계정 행과 같은 모양이라 그래프는 그대로 쓴다.
  const [antigravityUsage, setAntigravityUsage] = useState<ProviderAccountView[]>([]);
  useEffect(() => {
    if (!accounts) return undefined;
    let cancelled = false;
    getAntigravityPacingUsage()
      .then((resources) => { if (!cancelled) setAntigravityUsage(resources); })
      // 조회 실패는 그래프에 이 공급자를 빼는 것으로 끝낸다. 계정 이력 오류와 달리
      // 사용자가 손볼 것이 없고(설치되지 않은 기기가 정상), 계정 소진율은 멀쩡하다.
      .catch(() => { if (!cancelled) setAntigravityUsage([]); });
    return () => { cancelled = true; };
  }, [accounts]);

  // 주기 이력은 사용량 갱신이 계정 스냅샷에 반영될 때 함께 쌓이므로, 스냅샷이 바뀔 때마다
  // 다시 읽으면 충분하다(스냅샷은 내용이 같으면 같은 참조를 유지한다).
  const [usageHistory, setUsageHistory] = useState<Map<string, AccountUsageHistory> | null>(null);
  const [usageHistoryError, setUsageHistoryError] = useState<string | null>(null);
  useEffect(() => {
    if (!accounts) return undefined;
    let cancelled = false;
    getAccountUsageHistory()
      .then((history) => {
        if (cancelled) return;
        setUsageHistory(new Map(history.accounts.map((entry) => [entry.accountId, entry])));
        setUsageHistoryError(null);
      })
      .catch((error: unknown) => {
        if (!cancelled) setUsageHistoryError(errorText(error));
      });
    return () => { cancelled = true; };
  }, [accounts]);

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
  const usageSeries = useMemo(() => [...weeklyUsage]
    .sort((left, right) => (
      providerOrder.indexOf(left.account.provider) - providerOrder.indexOf(right.account.provider)
      || left.account.displayName.localeCompare(right.account.displayName, "ko")
      || left.account.id.localeCompare(right.account.id)
    ))
    .map((row, index) => ({
      row,
      colorIndex: Math.min(index, USAGE_SERIES_COLORS - 1),
      months: usageMonths.map((month) => (usageHistory
        ? cumulativeUsage(usageHistory.get(row.account.id) ?? null, row.windows.map((window) => window.label), month)
        : null)),
    })), [providerOrder, usageHistory, usageMonths, weeklyUsage]);

  return (
    <article className="panel panel-wide chart-panel" data-ui-anchor="dashboard.account-usage">
      <PanelHeading
        className="account-usage-heading"
        title={text("계정 소진율", "Account burn rate")}
        detail={text(
          `최근 ${USAGE_CHART_MONTHS}개월 계정별 제공한도 소비율`,
          `Share of each account's allowance consumed over the last ${USAGE_CHART_MONTHS} months`,
        )}
      >
        {usageSeries.length > 0 && (
          <div className="legend account-usage-legend" aria-label={text("계정 범례", "Account legend")}>
            {usageSeries.map(({ row, colorIndex }) => (
              <span key={`${row.account.provider}:${row.account.id}`} title={`${sourceName(row.account.provider)} · ${accountLabel(row.account)}`}>
                <i className={`account-usage-swatch series-${colorIndex}`} />
                {accountLabel(row.account)}
                {row.account.isActive && <em>{text("기본", "Default")}</em>}
              </span>
            ))}
          </div>
        )}
      </PanelHeading>
      {!accounts ? (
        <EmptyState title={text("계정 정보를 불러오는 중입니다", "Loading account information")} />
      ) : weeklyUsage.length === 0 ? (
        <EmptyState
          title={text("등록된 계정이 없습니다", "No registered accounts")}
          detail={text(
            "계정 관리에서 Claude·Codex 계정을 추가하면 소진율이 여기에 나타납니다.",
            "Add Claude or Codex accounts in account management and their burn rate appears here.",
          )}
        />
      ) : (
        <>
          {usageHistoryError !== null && (
            <p className="account-usage-history-error" role="alert">
              {text("사용량 이력을 읽지 못했습니다:", "Could not read usage history:")} {usageHistoryError}
            </p>
          )}
          <AccountUsageChart months={usageMonths} series={usageSeries} historyLoaded={usageHistory !== null} />
        </>
      )}
    </article>
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
/** 계정 계열 색 수. `--usage-series-N` 변수와 같아야 하고, 넘치는 계정은 마지막 색을 공유한다. */
const USAGE_SERIES_COLORS = 8;
/** y축 눈금(위에서 아래로). 격자 한 칸 25%p와 같다. */
const USAGE_AXIS_TICKS = [100, 75, 50, 25, 0];

interface AccountUsageSeries {
  row: WeeklyUsageRow;
  colorIndex: number;
  /** `months`와 같은 순서. 이력이 아직 없으면 null. */
  months: (CumulativeUsage | null)[];
}

interface AccountUsageChartProps {
  months: MonthPeriod[];
  series: AccountUsageSeries[];
  historyLoaded: boolean;
}

/**
 * 한 달·한 계정 막대의 도움말 본문. 이력 상태에 따라 네 갈래인데, 언어마다 문장을 통째로
 * 두어야 하므로 그래프 본문에서 떼어 둔다.
 */
function usageBarDetail(cumulative: CumulativeUsage | null, historyLoaded: boolean, text: Text, locale: AppLocale): string {
  if (!historyLoaded) return text("이력을 불러오는 중입니다", "Loading history");
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

/**
 * 주간 세션 추이와 같은 기둥 그래프. 달마다 기둥 하나, 그 안에 계정별 막대가 나란히
 * 서고 높이가 그 달의 소진율(0~100%)이다. 격자 한 칸이 25%p. 관측 전이라 계산할 수
 * 없는 달은 바닥의 빗금 자리로 남겨 0%와 구분하고, 이번 달은 진행 중이므로 지금까지
 * 준 제공량 대비로 계산돼 있다. 값은 주간 세션 추이처럼 도움말로 읽는다.
 */
function AccountUsageChart({ months, series, historyLoaded }: AccountUsageChartProps) {
  const { text, locale } = useI18n();
  const currentKey = months[months.length - 1]?.key;
  return (
    <figure className="account-usage-figure">
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
            {series.map(({ row, colorIndex, months: values }) => {
              const account = row.account;
              const name = accountLabel(account);
              const cumulative = values[monthIndex] ?? null;
              const percent = cumulative?.consumedPercent ?? null;
              const detail = usageBarDetail(cumulative, historyLoaded, text, locale);
              const label = percent !== null ? `${Math.round(percent)}%` : "—";
              const currentNote = month.key === currentKey ? text(" (이번 달, 지금까지)", " (this month, so far)") : "";
              const title = `${month.label} · ${name}\n${text(`소진율 ${label}`, `Burn rate ${label}`)}${currentNote}\n${detail}`;
              return (
                <div
                  className={`week-bar account-usage-bar${percent === null ? " empty" : ` series-${colorIndex}`}`}
                  style={{ height: `${percent === null ? 0 : Math.min(100, percent)}%` }}
                  key={`${account.provider}:${account.id}`}
                  title={title}
                  role="img"
                  aria-label={text(`${month.label} ${name} 소진율 ${label}`, `${month.label} ${name} burn rate ${label}`)}
                />
              );
            })}
          </div>
          <span>{month.label}</span>
        </div>
      ))}
      </div>
    </figure>
  );
}

function ProviderCard({ provider, onConnect }: { provider: ProviderStatus; onConnect: (provider: ProviderStatus) => void }) {
  const { text } = useI18n();
  const needsConnection = provider.history.detected && !provider.cli.detected;
  const content = <>
    <span className={`provider-dot provider-dot-${provider.provider}`} />
    <div className="provider-status-copy">
      <strong>{provider.displayName}</strong>
      <span>
        {provider.cli.detected
          ? text("CLI 연결됨", "CLI connected")
          : needsConnection
            ? text("CLI 미연결 · 클릭해 연결", "CLI not connected · click to connect")
            : text("CLI 미탐지", "CLI not detected")}
      </span>
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
      aria-label={text(`${provider.displayName} CLI 연결 관리 열기`, `Open ${provider.displayName} CLI connection management`)}
    >
      {content}
    </button>
  );
}

function ScheduleOverviewRow({ schedule, runs, onOpen }: { schedule: ScheduledRequest; runs: ScheduleRun[]; onOpen: () => void }) {
  const { text } = useI18n();
  const last = runs[0];
  const activeRun = runs.find((run) => run.status === "running" || isWaitingRunStatus(run.status));
  const queued = Boolean(schedule.manualRunRequestedAt) && !activeRun;
  const status = !schedule.enabled ? "paused" : activeRun && isWaitingRunStatus(activeRun.status) ? activeRun.status : activeRun ? "running" : queued ? "requested" : last?.status ?? "idle";
  const statusLabel = !schedule.enabled
    ? text("일시정지", "Paused")
    : activeRun
      ? runStatusLabel(activeRun.status, text)
      : queued
        ? text("실행 요청됨", "Run requested")
        : last
          ? runStatusLabel(last.status, text)
          : text("대기", "Waiting");
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

const WEEKDAY_LABELS = ["일", "월", "화", "수", "목", "금", "토"];
const WEEKDAY_LABELS_EN = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function recurrenceLabel(recurrence: ScheduleRecurrence, text: Text): string {
  const time = `${String(recurrence.hour).padStart(2, "0")}:${String(recurrence.minute).padStart(2, "0")}`;
  switch (recurrence.frequency) {
    case "hourly": return recurrence.interval === 1 ? text("매시간", "Every hour") : text(`매 ${recurrence.interval}시간`, `Every ${recurrence.interval} hours`);
    case "daily": return text(`매일 ${time}`, `Daily at ${time}`);
    case "weekdays": return text(`평일 ${time}`, `Weekdays at ${time}`);
    case "weekly": return text(
      `매주 ${WEEKDAY_LABELS[recurrence.weekday] ?? "?"}요일 ${time}`,
      `Every ${WEEKDAY_LABELS_EN[recurrence.weekday] ?? "?"} at ${time}`,
    );
    case "cron": return `Cron ${recurrence.cron ?? "–"}`;
    case "auto": return text("자동 · 가드 창 간격", "Auto · guard window interval");
  }
}

function runStatusLabel(status: ScheduleRun["status"], text: Text): string {
  switch (status) {
    case "completed": return text("완료", "Completed");
    case "failed": return text("실패", "Failed");
    case "cancelled": return text("취소됨", "Cancelled");
    case "skipped": return text("건너뜀", "Skipped");
    case "waitingForAccount": return text("계정 준비 대기", "Waiting for account");
    case "waitingForUsage": return text("사용량 복구 대기", "Waiting for usage to recover");
    default: return text("실행 중", "Running");
  }
}

/**
 * 패널 제목과 설명, 그리고 그 오른쪽에 서는 조작 버튼이나 범례. 대시보드의 패널이 모두
 * 같은 구조를 쓰므로 마크업을 한 곳에 둔다.
 */
function PanelHeading({ title, detail, className, children }: { title: ReactNode; detail: ReactNode; className?: string; children?: ReactNode }) {
  return (
    <div className={className ? `panel-heading ${className}` : "panel-heading"}>
      <div>
        <h2>{title}</h2>
        <p>{detail}</p>
      </div>
      {children}
    </div>
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
