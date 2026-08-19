import { formatBytes, formatRelative, formatTokens } from "../lib/format";
import type { ManagerSnapshot, ProviderStatus, ScheduleRecurrence, ScheduleRun, ScheduledRequest, SchedulerSnapshot, SessionSummary } from "../types";
import { EmptyState, SourceBadge } from "./Shared";

interface DashboardProps {
  snapshot: ManagerSnapshot;
  scheduler: SchedulerSnapshot | null;
  onOpenSession: (session: SessionSummary) => void;
  onOpenSchedules: () => void;
  onConnectCli: (provider: ProviderStatus) => void;
}

const VISIBLE_SCHEDULES = 7;

export function DashboardView({ snapshot, scheduler, onOpenSession, onOpenSchedules, onConnectCli }: DashboardProps) {
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

  return (
    <div className="view-stack">
      <section className="stat-grid">
        <StatCard
          label="전체 세션"
          value={dashboard.sessionCount.toLocaleString()}
          detail={`Claude ${dashboard.sessionsBySource.claude} · Codex ${dashboard.sessionsBySource.codex} · AG ${dashboard.sessionsBySource.antigravity}`}
        />
        <StatCard
          label="총 토큰"
          value={formatTokens(dashboard.tokens.total)}
          detail="캐시 토큰 포함"
        />
        <StatCard
          label="인덱싱 용량"
          value={formatBytes(dashboard.disk.total)}
          detail="원본 파일은 읽기 전용"
        />
        <StatCard
          label="스킬 / 에이전트"
          value={`${dashboard.skillCount} / ${dashboard.agentCount}`}
          detail="로컬 정의 자동 탐지"
        />
      </section>

      <section className="provider-strip">
        {status.providers.map((provider) => <ProviderCard provider={provider} onConnect={onConnectCli} key={provider.provider} />)}
      </section>

      <section className="dashboard-grid">
        <article className="panel chart-panel">
          <div className="panel-heading">
            <div>
              <h2>주간 세션 추이</h2>
              <p>최근 12주 생성·수정된 세션</p>
            </div>
            <div className="legend"><i className="claude" />Claude <i className="codex" />Codex <i className="antigravity" />AG</div>
          </div>
          <div className="weekly-chart">
            {dashboard.weekly.map((week) => {
              const total = week.claude + week.codex + week.antigravity;
              const height = Math.max(4, (total / maxWeek) * 100);
              return (
                <div className="week-column" key={week.weekStart} title={`${total}개`}>
                  <div className="week-bar" style={{ height: `${height}%` }}>
                    {total > 0 && (
                      <>
                        <span className="bar-claude" style={{ flex: week.claude }} />
                        <span className="bar-codex" style={{ flex: week.codex }} />
                        <span className="bar-antigravity" style={{ flex: week.antigravity }} />
                      </>
                    )}
                  </div>
                  <span>{new Date(week.weekStart).toLocaleDateString("ko-KR", { month: "numeric", day: "numeric" })}</span>
                </div>
              );
            })}
          </div>
        </article>

        <article className="panel">
          <div className="panel-heading">
            <div>
              <h2>반복 일정</h2>
              <p>{scheduler
                ? `${scheduler.paused ? "전체 일시정지됨 · " : ""}활성 ${enabledCount} / 전체 ${sortedSchedules.length} · 다음 실행 순`
                : "예약 자동 요청 현황"}</p>
            </div>
            <button className="button" type="button" onClick={onOpenSchedules}>관리</button>
          </div>
          {!scheduler ? (
            <EmptyState title="반복 일정을 불러오는 중입니다" />
          ) : sortedSchedules.length === 0 ? (
            <EmptyState title="등록된 반복 일정이 없습니다" detail="관리를 눌러 첫 반복 요청을 만드세요." />
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
                  외 {sortedSchedules.length - VISIBLE_SCHEDULES}개 반복 일정 보기
                </button>
              )}
            </div>
          )}
        </article>

        <article className="panel">
          <div className="panel-heading">
            <div>
              <h2>모델 분포</h2>
              <p>세션에 기록된 모델</p>
            </div>
          </div>
          {dashboard.models.length === 0 ? (
            <EmptyState title="모델 기록이 없습니다" />
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

        <article className="panel">
          <div className="panel-heading">
            <div>
              <h2>프로젝트 Top 10</h2>
              <p>연결된 작업 디렉터리 기준</p>
            </div>
          </div>
          {dashboard.topProjects.length === 0 ? (
            <EmptyState title="프로젝트 기록이 없습니다" />
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

        <article className="panel panel-wide">
          <div className="panel-heading">
            <div>
              <h2>최근 세션</h2>
              <p>업데이트 순</p>
            </div>
          </div>
          {dashboard.recent.length === 0 ? (
            <EmptyState title="세션이 없습니다" />
          ) : (
            <div className="recent-list">
              {dashboard.recent.map((session) => (
                <button key={`${session.source}:${session.id}`} type="button" onClick={() => onOpenSession(session)}>
                  <SourceBadge source={session.source} />
                  <span className="recent-title">{session.title}</span>
                  <time>{formatRelative(session.updatedAt)}</time>
                </button>
              ))}
            </div>
          )}
        </article>
      </section>
    </div>
  );
}

function ProviderCard({ provider, onConnect }: { provider: ProviderStatus; onConnect: (provider: ProviderStatus) => void }) {
  const needsConnection = provider.history.detected && !provider.cli.detected;
  const content = <>
    <span className={`provider-dot provider-dot-${provider.provider}`} />
    <div className="provider-status-copy">
      <strong>{provider.displayName}</strong>
      <span>{provider.cli.detected ? "CLI 연결됨" : needsConnection ? "CLI 미연결 · 클릭해 연결" : "CLI 미탐지"}</span>
    </div>
    <span className={provider.history.detected ? "health ready" : "health muted"}>
      {provider.history.detected ? "채팅 탐지" : "데이터 없음"}
    </span>
  </>;
  return (
    <button className="provider-status provider-status-action" type="button" onClick={() => onConnect(provider)} aria-label={`${provider.displayName} CLI 연결 관리 열기`}>
      {content}
    </button>
  );
}

function ScheduleOverviewRow({ schedule, runs, onOpen }: { schedule: ScheduledRequest; runs: ScheduleRun[]; onOpen: () => void }) {
  const last = runs[0];
  const activeRun = runs.find((run) => run.status === "running" || run.status === "waitingForAccount");
  const queued = Boolean(schedule.manualRunRequestedAt) && !activeRun;
  const status = !schedule.enabled ? "paused" : activeRun?.status === "waitingForAccount" ? "waitingForAccount" : activeRun ? "running" : queued ? "requested" : last?.status ?? "idle";
  const statusLabel = !schedule.enabled ? "일시정지" : activeRun ? runStatusLabel(activeRun.status) : queued ? "실행 요청됨" : last ? runStatusLabel(last.status) : "대기";
  return (
    <button className="dashboard-schedule-row" type="button" onClick={onOpen} title={schedule.prompt}>
      <div className="dashboard-schedule-top">
        <SourceBadge source={schedule.source} />
        <span className="dashboard-schedule-name">{schedule.name}</span>
        <span className={`schedule-status ${status}`}>{statusLabel}</span>
      </div>
      <div className="dashboard-schedule-sub">
        <span>{recurrenceLabel(schedule.recurrence)}</span>
        <span>다음 {schedule.enabled ? formatRelative(schedule.nextRunAt) : "–"}</span>
        {schedule.lastRunAt !== null && <span>지난 실행 {formatRelative(schedule.lastRunAt)}</span>}
      </div>
    </button>
  );
}

const WEEKDAY_LABELS = ["일", "월", "화", "수", "목", "금", "토"];

function recurrenceLabel(recurrence: ScheduleRecurrence): string {
  const time = `${String(recurrence.hour).padStart(2, "0")}:${String(recurrence.minute).padStart(2, "0")}`;
  switch (recurrence.frequency) {
    case "hourly": return recurrence.interval === 1 ? "매시간" : `매 ${recurrence.interval}시간`;
    case "daily": return `매일 ${time}`;
    case "weekdays": return `평일 ${time}`;
    case "weekly": return `매주 ${WEEKDAY_LABELS[recurrence.weekday] ?? "?"}요일 ${time}`;
    case "cron": return `Cron ${recurrence.cron ?? "–"}`;
  }
}

function runStatusLabel(status: ScheduleRun["status"]): string {
  return status === "completed" ? "완료" : status === "failed" ? "실패" : status === "cancelled" ? "취소됨" : status === "skipped" ? "건너뜀" : status === "waitingForAccount" ? "계정 전환 대기" : "실행 중";
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
