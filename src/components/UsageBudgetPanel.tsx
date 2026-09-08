import { AlertTriangle, CalendarClock, ChartPie, ChevronDown, ChevronRight, Gauge, LoaderCircle, PauseCircle, RefreshCw, Settings } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { usageLevel } from "../lib/accountUsage";
import { reasoningLabel } from "../lib/chatSettings";
import { formatDate, formatRelative, sourceName } from "../lib/format";
import { useI18n } from "../lib/i18n";
import { acknowledgeDrainNotice, deleteScheduledRequest, getSchedulerSnapshot, getSystemWorkflows, getUsageBudget, runScheduledRequestNow, setScheduleEnabled, setSystemWorkflowPacing, setUsageBudgetAccount, setUsageBudgetConsumer, setUsageBudgetPolicy, setUsageBudgetSavings, showNativeNotification } from "../lib/ipc";
import { accountLabel, consumerSummary, defaultQuietHours, describeQuietHours, poolSummary, quietWeekdays, WEEKDAY_NAMES, WEEKDAY_NAMES_EN, WEEKDAY_ORDER } from "../lib/pacingSummary";
import { isWaitingRunStatus } from "../lib/schedulerSnapshot";
import { describeScheduleWorkflow } from "../lib/scheduleWorkflow";
import type { KnownReasoningEffort, LaneReasoningEffort, ProviderId, QuietHours, SavingsDefaults, ScheduleRun, ScheduledRequest, SetUsageBudgetAccountRequest, SetUsageBudgetConsumerRequest, SystemWorkflowSummary, UsageBudgetAccount, UsageBudgetConsumer, UsageBudgetConsumerAccountCost,
  UsageBudgetConsumerEffortCost,
  SpendProfile, UsageBudgetDefaults, UsageBudgetSavingsReport, UsageBudgetSnapshot } from "../types";
import { PacedTriggerEditor } from "./PacedTriggerEditor";
import { AppToggle, ErrorBanner, HelpHint, Modal, SourceBadge, useConfirm } from "./Shared";
import { errorText } from "../lib/errorText";


function percent(value: number | null | undefined, digits = 1): string {
  return value === null || value === undefined ? "–" : `${value.toFixed(digits)}%`;
}

function tokenCount(value: number): string {
  return Math.round(value).toLocaleString();
}

/** 계정별 비용을 공급자 묶음으로 바꿔 카드 안에서 같은 배지를 반복하지 않게 한다. */
/**
 * 요약 수치 한 칸. `<div><dt>이름</dt><dd>값<span>보조</span></dd></div>`이라는 같은 모양이
 * 이 화면의 요약 목록 네 곳에 열일곱 벌 흩어져 있어, 칸 하나를 더하거나 보조 문구의 자리를
 * 바꾸는 변경이 매번 여러 곳을 같이 고쳐야 했다. 모양은 여기 한 벌만 둔다.
 * `note`를 주지 않으면 보조 `<span>`을 그리지 않는다(계정별 소비 표처럼 값만 있는 칸).
 */
function Metric({ label, value, note, title, className }: {
  label: ReactNode;
  value: ReactNode;
  note?: ReactNode;
  title?: string;
  className?: string;
}) {
  return (
    <div className={className}>
      <dt>{label}</dt>
      <dd title={title}>{value}{note === undefined ? null : <span>{note}</span>}</dd>
    </div>
  );
}

/** 등급별 소비를 공급자별로 묶고, 사다리 순서(싼 것부터)로 세운다. */
function groupEffortCosts(costs: UsageBudgetConsumerEffortCost[]): { provider: ProviderId; costs: UsageBudgetConsumerEffortCost[] }[] {
  const order = ["low", "medium", "high", "xhigh", "max"];
  const grouped = new Map<ProviderId, UsageBudgetConsumerEffortCost[]>();
  for (const cost of costs) {
    grouped.set(cost.provider, [...(grouped.get(cost.provider) ?? []), cost]);
  }
  return EFFORT_LANE_ORDER
    .filter((provider) => grouped.has(provider))
    .map((provider) => ({
      provider,
      costs: [...grouped.get(provider)!].sort((a, b) => order.indexOf(a.reasoningEffort) - order.indexOf(b.reasoningEffort)),
    }));
}

function groupAccountCosts(costs: UsageBudgetConsumerAccountCost[]): { provider: ProviderId; costs: UsageBudgetConsumerAccountCost[] }[] {
  const grouped = new Map<ProviderId, UsageBudgetConsumerAccountCost[]>();
  for (const cost of costs) {
    const providerCosts = grouped.get(cost.provider) ?? [];
    providerCosts.push(cost);
    grouped.set(cost.provider, providerCosts);
  }
  return [...grouped].map(([provider, providerCosts]) => ({ provider, costs: providerCosts }));
}

/** 빈 입력은 "캡 없음"(null), 숫자는 0~100으로 잘라 보낸다. */
function parsePercent(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value)) return null;
  return Math.min(100, Math.max(0, value));
}

/**
 * 절감 목표 초안. 저장값(`SavingsDefaults`)과 달리 `baselineRuns`가 비어 있을 수 있다 —
 * 숫자 칸을 고치려면 먼저 지워야 하고, 그때 곧바로 기본값으로 되돌리면 지우는 순간 5가
 * 다시 채워져 다른 값을 넣을 수 없다. 범위 보정은 저장할 때 한 번만 한다.
 */
interface SavingsDraft {
  targetReductionPercent: number | null;
  baselineRuns: number | null;
}

function savingsDraftFrom(savings: SavingsDefaults): SavingsDraft {
  return { targetReductionPercent: savings.targetReductionPercent ?? null, baselineRuns: savings.baselineRuns };
}

/** 빈 입력은 미입력(null). 범위는 저장할 때 자르므로 여기서는 자르지 않는다. */
/**
 * 기준선 회차 수의 허용 범위. 백엔드가 1~32 밖을 거절하므로(usage_budget_policy.rs) 저장
 * 경로와 화면 보정이 같은 규칙을 봐야 한다 — 한쪽만 자르면 조용히 다른 값이 저장된다.
 */
function clampBaselineRuns(value: number): number {
  return Math.min(32, Math.max(1, Math.round(value)));
}

function parseCount(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

/** 스냅샷의 스케줄을 편집 초안으로. 없으면 꺼진 기본 초안, 구형 응답의 요일 누락은 매일로 읽는다. */
function quietDraftFrom(defaults: UsageBudgetDefaults): QuietHours {
  const saved = defaults.quietHours;
  if (!saved) return defaultQuietHours(Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC");
  return { ...saved, weekdays: quietWeekdays(saved) };
}

/**
 * 예산 기본값은 백엔드가 통째로 바꾸므로, 예산 기본값 모달과 스케줄 모달이 서로의 값을 지우지
 * 않게 저장 본문을 한 곳에서 조립한다.
 */
function defaultsPayload(draft: UsageBudgetDefaults, quiet: QuietHours | null): UsageBudgetDefaults {
  return {
    // 전체 스위치도 매번 실어 보낸다 — 백엔드가 기본값 한 벌을 통째로 교체하므로,
    // 예산 기본값이나 스케줄만 저장하는 경로에서 빠뜨리면 그때 페이싱이 다시 켜진다.
    enabled: draft.enabled ?? true,
    windowLabel: draft.windowLabel?.trim() ? draft.windowLabel.trim() : null,
    targetPercent: draft.targetPercent ?? null,
    guardWindowLabel: draft.guardWindowLabel?.trim() ? draft.guardWindowLabel.trim() : null,
    guardPercent: draft.guardPercent ?? null,
    quietHours: quiet,
    spendProfile: draft.spendProfile ?? null,
    drain: draft.drain ?? false,
    drainReserveCredits: draft.drainReserveCredits ?? null,
  };
}

/**
 * 소비자·계정 저장은 언제나 설정 한 벌을 통째로 실어 보낸다(백엔드가 받은 값으로 교체한다).
 * 그래서 호출 자리마다 자기가 바꾸지 않는 칸까지 다시 적어야 했고, 한 자리에서 workflowId나
 * label을 빠뜨리면 그 칸이 조용히 지워진다. 바뀌지 않는 부분은 여기서 한 번만 만들고, 호출
 * 자리에는 그 호출이 실제로 바꾸는 칸만 남긴다.
 */
function consumerRequest(consumer: UsageBudgetConsumer, patch: Partial<SetUsageBudgetConsumerRequest>): SetUsageBudgetConsumerRequest {
  return {
    scheduleId: consumer.scheduleId,
    // 미등록 소비자(enabled === null)의 저장은 등록으로 친다 — 참여를 명시적으로 끄는
    // toggleConsumer만 patch로 false를 덮어쓴다.
    enabled: consumer.enabled ?? true,
    workflowId: consumer.workflowId,
    label: consumer.label ?? consumer.name,
    ...patch,
  };
}

function accountRequest(account: UsageBudgetAccount, patch: Partial<SetUsageBudgetAccountRequest>): SetUsageBudgetAccountRequest {
  return {
    accountId: account.accountId,
    pacingEnabled: account.pacingEnabled,
    targetPercent: account.targetPercent,
    guardPercent: account.guardPercent,
    ...patch,
  };
}

/** 스케줄 모달 머리줄의 현재 상태 한 줄. */
function quietStatusText(snapshot: UsageBudgetSnapshot, text: (ko: string, en: string) => string): string {
  const status = snapshot.quietStatus;
  if (!status) {
    return text(
      "지금은 종일 작동합니다. 제한 시간대를 켜면 체크한 요일의 그 시간에는 회차가 뜨지 않습니다.",
      "Pacing runs all day. Turn on quiet hours to keep rounds from launching during them on the checked days.",
    );
  }
  if (status.blocked) {
    return text(`제한 시간대 · ${formatDate(status.changesAt)}에 재개`, `Quiet hours · resumes ${formatDate(status.changesAt)}`);
  }
  return status.changesAt === null
    ? text("지금 작동 중", "Running now")
    : text(`지금 작동 중 · ${formatDate(status.changesAt)}에 멈춤`, `Running now · pauses ${formatDate(status.changesAt)}`);
}

/**
 * 다음 회차에 배정될 계정을 한 줄로. 같은 계정이 여러 건이면 ×N을 붙이고, 봉투가 고른 추론수준과
 * 그 근거(고정 / 자동이면 리셋까지 남은 회차당 감당 건수)를 이름 뒤에 단다.
 * 미리보기 행에는 이메일만 실려 오므로 accountId로 스냅샷 계정을 되찾아 카드의 다른 줄과
 * 같은 표시 이름을 쓰고, 못 찾으면 이메일·id로 떨어진다.
 */
function nextRunAccountsLabel(
  runs: NonNullable<UsageBudgetConsumer["nextRun"]>["runs"],
  accounts: UsageBudgetAccount[],
  text: (ko: string, en: string) => string,
): string {
  return runs
    .map((run) => {
      const account = accounts.find((item) => item.accountId === run.accountId);
      const name = account ? accountLabel(account) : run.email ?? run.accountId;
      // 출처가 없는 응답(구형 백엔드)은 근거를 모르는 것이지 기본 수준이 아니므로 아무것도 붙이지 않는다.
      const basis = !run.reasoningEffort || !run.reasoningEffortSource
        ? ""
        : run.reasoningEffortSource === "fixed"
          ? text("(고정)", "(fixed)")
          : typeof run.headroomRunsPerRound === "number"
            ? text(`(여력 ${run.headroomRunsPerRound.toFixed(1)}건/회차)`, `(${run.headroomRunsPerRound.toFixed(1)} runs/round headroom)`)
            : text("(자동 기본)", "(auto default)");
      const effort = run.reasoningEffort ? ` · ${reasoningLabel(run.reasoningEffort)}${basis}` : "";
      return `${name}${effort}${run.count > 1 ? ` ×${run.count}` : ""}`;
    })
    .join(", ");
}

/**
 * 백엔드가 사다리를 아직 보내지 않는 구형 응답일 때의 공급자별 추론수준 선택지. 봉투의 여력
 * 사다리와 같은 목록이다(Codex는 xhigh, Antigravity는 high까지).
 */
const FALLBACK_EFFORT_LADDERS: Record<ProviderId, KnownReasoningEffort[]> = {
  claude: ["low", "medium", "high", "xhigh", "max"],
  codex: ["low", "medium", "high", "xhigh"],
  antigravity: ["low", "medium", "high"],
};

const EFFORT_LANE_ORDER: ProviderId[] = ["claude", "codex", "antigravity"];

/** 최근 회차 실효를 셀 표본 수. 자동 주기가 10~20분이면 서너 시간을 덮는다. */
const RECENT_ROUND_SAMPLE = 12;

/**
 * 최근 회차 중 실제로 기동한 회차와 쉰 회차. 회차 봉투는 기동이 0건이어도 성공이라
 * 실행 목록이 전부 "완료"로 보인다 — 몇 시간째 아무것도 안 띄우고 있어도 그렇다.
 */
function recentRoundTally(runs: ScheduleRun[] | undefined): { worked: number; rested: number; launched: number } | null {
  const rounds = (runs ?? []).filter((run) => run.round);
  if (rounds.length === 0) return null;
  return {
    worked: rounds.filter((run) => (run.round?.launchedRuns ?? 0) > 0).length,
    rested: rounds.filter((run) => (run.round?.launchedRuns ?? 0) === 0).length,
    launched: rounds.reduce((sum, run) => sum + (run.round?.launchedRuns ?? 0), 0),
  };
}

/** 소비자 행 요약에 붙일 레인별 추론수준 설정. 전부 자동·상한 없음이면 빈 문자열. */
function laneEffortSummary(consumer: UsageBudgetConsumer, text: (ko: string, en: string) => string): string {
  const parts = EFFORT_LANE_ORDER.flatMap((provider) => {
    const lane = consumer.reasoningEfforts?.[provider];
    if (lane?.fixed) return [text(`${sourceName(provider)} ${reasoningLabel(lane.fixed)} 고정`, `${sourceName(provider)} fixed ${lane.fixed}`)];
    if (lane?.maxAuto || lane?.minAuto) {
      const range = `${lane.minAuto ? reasoningLabel(lane.minAuto) : ""}~${lane.maxAuto ? reasoningLabel(lane.maxAuto) : ""}`;
      return [text(`${sourceName(provider)} 자동 ${range}`, `${sourceName(provider)} auto ${range}`)];
    }
    return [];
  });
  return parts.length > 0 ? ` · ${text("추론수준", "effort")} ${parts.join(", ")}` : "";
}

function cadenceLabel(minutes: number | null, text: (ko: string, en: string) => string): string {
  if (minutes === null) return text("간격 알 수 없음", "Unknown cadence");
  if (minutes % 60 === 0) return text(`${minutes / 60}시간마다`, `Every ${minutes / 60}h`);
  return text(`${minutes}분마다`, `Every ${minutes} min`);
}

/**
 * 회차가 실제로 무엇을 했는지. 회차 봉투는 기동이 0건이어도 성공으로 끝나므로 상태만으로는
 * 일한 회차와 쉰 회차가 같아 보인다. 목록에서 그 둘을 가르는 것이 이 줄이다.
 */
function roundOutcomeText(run: ScheduleRun | null, text: (ko: string, en: string) => string): string | null {
  const round = run?.round;
  if (!round) return null;
  if (round.launchedRuns === 0) return text("쉼 · 기동 없음", "rested · nothing launched");
  const stale = round.staleRuns > 0 ? text(` · 정리 ${round.staleRuns}건`, ` · ${round.staleRuns} cleaned`) : "";
  return text(`기동 ${round.launchedRuns}건`, `${round.launchedRuns} launched`) + stale;
}

function runStatusText(status: ScheduleRun["status"], text: (ko: string, en: string) => string): string {
  switch (status) {
    case "completed": return text("완료", "completed");
    case "failed": return text("실패", "failed");
    case "cancelled": return text("취소됨", "cancelled");
    case "skipped": return text("건너뜀", "skipped");
    case "waitingForAccount": return text("계정 준비 대기", "waiting for account");
    case "waitingForUsage": return text("사용량 복구 대기", "waiting for usage");
    default: return text("실행 중", "running");
  }
}

/**
 * 회차 카드의 상세정보를 처음부터 접어 둘 기준 폭(px). 뷰포트가 아니라 패널 자신의 폭을
 * 잰다 — 패널은 이미 컨테이너(`container-type: inline-size`)이고 좁은 화면 규칙도 그 폭을
 * 기준으로 걸려 있어, 창은 넓지만 패널이 좁은 경우(사이드바가 열린 데스크톱)에도 카드가
 * 세로로 길어지는 것은 똑같기 때문이다. 값은 패널의 좁은 화면 컨테이너 쿼리와 맞춘다.
 */
const NARROW_PANEL_WIDTH = 760;

/**
 * 워크플로 → 워크플로 페이싱 탭. 페이싱 회차가 나눠 쓸 계정 풀, 소비자(페이싱을 켠
 * 워크플로를 돌리는 반복 요청)의 참여와 우선순위, 기본 목표·가드를 사용자가 직접 고른다.
 * 선택은 정책 저장소 하나가 원천이고 워크플로 인자는 그 캡 안에서만 유효하다.
 *
 * 어떤 워크플로가 이 화면의 대상인지는 계약이 정한다(사용량을 쓰는 계약이면 대상) — 여기서는
 * 그 결과(대상 워크플로 수)만 보여 준다.
 *
 * 화면은 **읽는 자리와 고치는 자리를 나눈다**. 카드에는 계산된 값(반복주기·평균 소진율·
 * 회당 소비·다음 실행)만 두고, 편집은 전부 편집 버튼이 여는 모달로 보낸다. 컨트롤을 행에
 * 인라인으로 깔면 좁은 화면에서 입력·토글이 세로로 쌓여 "지금 이 회차가 어떤 상태인가"가
 * 읽히지 않기 때문이다. 모달은 폭과 무관하게 같은 자리를 쓴다 — 화면 크기마다 편집 방법이
 * 달라지면 조작을 다시 배워야 한다.
 */
/**
 * 계정 풀 카드. 페이싱 후보 계정의 평균·최다 소진과 계정별 막대를 읽기 전용으로 보여 준다.
 * UsageBudgetPanel 본문이 1000줄을 넘겨 카드 하나를 고칠 때도 전체를 훑어야 했다 —
 * 바깥 상태를 쓰지 않는 이 카드부터 떼어낸다.
 */
function AccountPoolSection({ snapshot, pool, busy, onOpenPool }: {
  snapshot: UsageBudgetSnapshot;
  pool: ReturnType<typeof poolSummary>;
  busy: string | null;
  onOpenPool: () => void;
}) {
  const { text } = useI18n();
  return (
    <section className="settings-subsection" data-ui-anchor="workflows.usage-budget.accounts">
      <header>
        <div>
          <strong>{text("계정 풀", "Account pool")}</strong>
          <small>
            {snapshot.poolConfigured
              ? text("켜진 계정만 페이싱 후보입니다. 워크플로 인자 필터는 이 풀 안에서만 좁힙니다.", "Only enabled accounts are candidates. Workflow filters narrow within this pool.")
              : text("켜진 계정이 없어 워크플로 인자 필터만 적용됩니다. 하나라도 켜면 그 계정들만 후보가 됩니다.", "No account is enabled, so only workflow filters apply. Enable one to make the pool authoritative.")}
          </small>
        </div>
      </header>
      <div className="usage-budget-cards">
        {snapshot.accounts.length === 0
          ? <p className="settings-empty">{text("등록된 공급자 계정이 없습니다.", "No provider accounts are registered.")}</p>
          : (
            <article className={`usage-budget-card usage-budget-pool-card${pool.pooled === 0 ? " muted" : ""}`}>
              <div className="usage-budget-card-head">
                <div>
                  <strong>{text(`페이싱 계정 ${pool.pooled} / ${pool.total}`, `Pacing accounts ${pool.pooled} / ${pool.total}`)}</strong>
                  <small>
                    {pool.pooled === 0
                      ? text("아직 참여 계정을 고르지 않았습니다.", "No account has been added to the pool yet.")
                      : text(`${snapshot.windowLabel} 창 기준 현황입니다.`, `Current state of the ${snapshot.windowLabel} window.`)}
                  </small>
                </div>
                <button
                  className="icon-button compact"
                  type="button"
                  onClick={onOpenPool}
                  disabled={busy !== null}
                  aria-label={text("계정 풀 설정", "Account pool settings")}
                  title={text("계정 풀 설정", "Account pool settings")}
                >
                  <Settings size={14} />
                </button>
              </div>
              <dl className="usage-budget-metrics">
                <Metric label={text("평균 소진율", "Average used")} value={percent(pool.averageUsedPercent, 0)} note={snapshot.windowLabel} />
                <Metric label={text("평균 순여유", "Average headroom")} value={percent(pool.averageHeadroomPercent, 0)} note={text("목표까지", "to target")} />
                <Metric
                  label={text("최다 소진 계정", "Busiest account")}
                  value={pool.busiest ? percent(pool.busiest.usedPercent, 0) : "–"}
                  note={pool.busiest?.label ?? "–"}
                />
                <Metric label={text("가장 이른 초기화", "Earliest reset")} value={formatRelative(pool.earliestResetAt)} note={text("창 리셋", "window reset")} />
              </dl>
              {snapshot.accounts.length > 0 && (
                <ul className="usage-budget-pool-bars">
                  {snapshot.accounts.map((account) => {
                    const raw = account.overview?.usedPercent;
                    const used = raw === null || raw === undefined ? null : Math.min(100, Math.max(0, raw));
                    const target = account.overview?.targetPercent ?? null;
                    const label = accountLabel(account);
                    return (
                      <li
                        className={`${used === null ? "unmeasured" : usageLevel(used)}${account.pacingEnabled ? "" : " off"}`}
                        key={account.accountId}
                        title={text(
                          `${label} · ${account.pacingEnabled ? "참여 중" : "제외됨"}${target === null ? "" : ` · 목표 ${Math.round(target)}%`}`,
                          `${label} · ${account.pacingEnabled ? "included" : "excluded"}${target === null ? "" : ` · target ${Math.round(target)}%`}`,
                        )}
                      >
                        <span>
                          <SourceBadge source={account.provider} />
                          <em>{label}</em>
                          <b>{used === null ? text("확인 불가", "n/a") : `${Math.round(used)}%`}</b>
                        </span>
                        <div
                          className="progress"
                          role="img"
                          aria-label={text(
                            `${label} ${snapshot.windowLabel} 사용량 ${used === null ? "확인 불가" : `${Math.round(used)}%`}`,
                            `${label} ${snapshot.windowLabel} usage ${used === null ? "unavailable" : `${Math.round(used)}%`}`,
                          )}
                        >
                          <span style={{ width: `${used ?? 0}%` }} />
                          {/* 목표선. 막대가 어디까지 차야 이 계정의 몫을 다 쓴 것인지 눈금으로 알린다. */}
                          {target !== null && target > 0 && target < 100 && <i style={{ left: `${target}%` }} />}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
              {(pool.disabledCount > 0 || pool.unmeasuredCount > 0) && (
                <p className="usage-budget-card-note">
                  {pool.disabledCount > 0 ? text(`비활성 계정 ${pool.disabledCount}개는 회차가 쓰지 못합니다.`, `${pool.disabledCount} disabled account(s) cannot be used.`) : ""}
                  {pool.disabledCount > 0 && pool.unmeasuredCount > 0 ? " " : ""}
                  {pool.unmeasuredCount > 0 ? text(`${pool.unmeasuredCount}개 계정은 이 창의 사용량을 읽지 못해 평균에서 빠졌습니다.`, `${pool.unmeasuredCount} account(s) have no usage for this window and are excluded from the averages.`) : ""}
                </p>
              )}
            </article>
          )}
      </div>
    </section>
  );
}

/**
 * 계정 풀 설정 모달. 계정별 목표 override와 참여 스위치만 다루고 바깥 초안 상태를 쓰지
 * 않으므로, 같은 계정 풀을 읽기로 보여 주는 AccountPoolSection 옆에 둔다.
 */
function AccountPoolModal({ snapshot, busy, onSetTarget, onToggle, onClose }: {
  snapshot: UsageBudgetSnapshot;
  busy: string | null;
  onSetTarget: (account: UsageBudgetAccount, raw: string) => void;
  onToggle: (account: UsageBudgetAccount, pacingEnabled: boolean) => void;
  onClose: () => void;
}) {
  const { text } = useI18n();
  return (
    <Modal title={text("계정 풀 설정", "Account pool settings")} onClose={onClose} size="wide">
      <p className="usage-budget-modal-note">
        {text(
          "참여를 켠 계정만 페이싱 후보가 됩니다. 목표 override는 그 계정에만 적용되는 상한이고, 비우면 기본 목표를 씁니다. 변경은 즉시 저장됩니다.",
          "Only accounts with participation on are pacing candidates. A target override caps that one account; leave it empty to use the default. Changes save immediately.",
        )}
      </p>
      <div className="usage-budget-modal-rows">
        {snapshot.accounts.map((account) => {
          const overview = account.overview;
          return (
            <div className={`usage-budget-modal-row${account.pacingEnabled ? "" : " muted"}`} key={account.accountId} data-account-id={account.accountId}>
              <div className="usage-budget-modal-row-main">
                <SourceBadge source={account.provider} />
                <div>
                  <strong>{accountLabel(account)}</strong>
                  <small>
                    {overview?.usedPercent !== null && overview?.usedPercent !== undefined
                      ? text(
                        `${snapshot.windowLabel} ${percent(overview.usedPercent, 0)} 사용 · 목표 ${percent(overview.targetPercent, 0)} · 미정산 예약 ${percent(overview.outstandingClaimPercent)} · 순여유 ${percent(overview.netHeadroomPercent)}`,
                        `${snapshot.windowLabel} used ${percent(overview.usedPercent, 0)} · target ${percent(overview.targetPercent, 0)} · outstanding claims ${percent(overview.outstandingClaimPercent)} · net headroom ${percent(overview.netHeadroomPercent)}`,
                      )
                      : text("이 창의 사용량이 없습니다", "No usage for this window")}
                    {account.disabled ? ` · ${text("비활성 계정", "disabled")}` : ""}
                    {(overview?.guards ?? []).map((guard) => (
                      <span className="usage-budget-guard-overview" key={guard.label}>
                        {" · "}
                        {guard.netHeadroomPercent === null
                          ? text(
                            `${guard.label} ${percent(guard.usedPercent, 0)} 사용 · 미정산 예약 ${percent(guard.outstandingClaimPercent)}`,
                            `${guard.label} used ${percent(guard.usedPercent, 0)} · outstanding claims ${percent(guard.outstandingClaimPercent)}`,
                          )
                          : text(
                            `${guard.label} ${percent(guard.usedPercent, 0)} 사용 · 상한 ${percent(guard.guardPercent, 0)} · 미정산 예약 ${percent(guard.outstandingClaimPercent)} · 순여유 ${percent(guard.netHeadroomPercent)}`,
                            `${guard.label} used ${percent(guard.usedPercent, 0)} · guard ${percent(guard.guardPercent, 0)} · outstanding claims ${percent(guard.outstandingClaimPercent)} · net headroom ${percent(guard.netHeadroomPercent)}`,
                          )}
                      </span>
                    ))}
                  </small>
                </div>
              </div>
              <div className="usage-budget-modal-row-controls">
                <label className="usage-budget-inline-field">
                  <span>{text("목표 override", "Target override")}</span>
                  <input
                    type="number"
                    min={0}
                    max={100}
                    defaultValue={account.targetPercent ?? ""}
                    placeholder={text("기본", "default")}
                    disabled={busy !== null}
                    onBlur={(event) => onSetTarget(account, event.target.value)}
                  />
                </label>
                <div className="usage-budget-toggle-field">
                  <span>{text("참여", "Enabled")}</span>
                  <AppToggle
                    checked={account.pacingEnabled}
                    disabled={busy !== null}
                    label={text(`${accountLabel(account)} 페이싱 참여`, `Include ${accountLabel(account)} in pacing`)}
                    onChange={(checked) => void onToggle(account, checked)}
                  />
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </Modal>
  );
}

/**
 * 페이싱 스케줄 모달. 제한 시간대 초안 하나만 읽고 쓰므로 패널 본문에서 떼어낸다 —
 * 초안이 유효한지(요일 하나 이상, 시작≠끝)는 이 모달의 저장 버튼만 보는 값이라 여기서 센다.
 */
function PacingScheduleModal({ snapshot, draft, busy, onChange, onSave, onClose }: {
  snapshot: UsageBudgetSnapshot;
  draft: QuietHours;
  busy: string | null;
  onChange: (next: QuietHours) => void;
  onSave: () => void;
  onClose: () => void;
}) {
  const { text } = useI18n();
  const draftInvalid = Boolean(draft.enabled && (draft.weekdays.length === 0 || draft.start === draft.end));
  return (
    <Modal title={text("페이싱 스케줄", "Pacing schedule")} onClose={onClose}>
      <section className="usage-budget-modal-section">
        <header>
          <strong>{text("페이싱을 멈출 시간대", "Quiet hours")}</strong>
          <small>{quietStatusText(snapshot, text)}</small>
        </header>
        <div className="usage-budget-defaults quiet-hours-form">
          <div className="usage-budget-toggle-field">
            <span>{text("제한 시간대 사용", "Use quiet hours")}</span>
            <AppToggle
              checked={draft.enabled}
              disabled={busy !== null}
              label={text("제한 시간대 사용", "Use quiet hours")}
              onChange={(checked) => onChange({ ...draft, enabled: checked })}
            />
          </div>
          <label className="wide">
            <span>{text("페이싱을 멈출 시간대", "Quiet hours")}</span>
            <div className="time-range">
              <input type="time" value={draft.start} disabled={!draft.enabled} onChange={(event) => onChange({ ...draft, start: event.target.value })} />
              <b>~</b>
              <input type="time" value={draft.end} disabled={!draft.enabled} onChange={(event) => onChange({ ...draft, end: event.target.value })} />
            </div>
            {draft.enabled && draft.end < draft.start && (
              <small>{text(`다음 날 ${draft.end}까지 이어지는 제한입니다(자정 넘김, 시작 요일 기준).`, `Continues past midnight until ${draft.end} the next day (counted on the start day).`)}</small>
            )}
          </label>
          <fieldset className="weekday-picker wide" disabled={!draft.enabled}>
            <legend>{text("적용 요일", "Days")}</legend>
            {WEEKDAY_ORDER.map((day) => (
              <label className="check-filter" key={day}>
                <input
                  type="checkbox"
                  checked={draft.weekdays.includes(day)}
                  onChange={(event) => onChange({
                    ...draft,
                    weekdays: event.target.checked
                      ? [...draft.weekdays, day].sort((left, right) => left - right)
                      : draft.weekdays.filter((other) => other !== day),
                  })}
                />
                {" "}{text(WEEKDAY_NAMES[day], WEEKDAY_NAMES_EN[day])}
              </label>
            ))}
          </fieldset>
          <p className="schedule-workflow-note wide">
            {text(
              `체크한 요일의 이 시간대에는 페이싱 회차가 뜨지 않고, 그 밖의 시간과 체크 안 한 요일은 종일 돕니다. 끝이 시작보다 이르면 다음 날까지 이어지는 제한이고 시작 요일에 속합니다(금 22:00~토 06:00은 금요일). 목표 사용률은 제한 밖의 열린 시간에 펴서 자동 주기와 회차당 기동 수가 그만큼 촘촘해지고, 제한 중에 만기가 온 회차는 재개 시각에 돕니다. 이미 도는 실행은 중단하지 않습니다. 시간대: ${draft.timezone}`,
              `On the checked days no paced round launches during these hours; all other times and unchecked days run all day. If the end is earlier than the start, the quiet hours continue into the next day and belong to the start day (Fri 22:00–Sat 06:00 is Friday). The target is spread over the open time outside quiet hours, so the auto cadence and runs per round tighten accordingly, and a round due during quiet hours launches when they end. Running work is never stopped. Time zone: ${draft.timezone}`,
            )}
          </p>
          <button className="button primary" type="button" onClick={onSave} disabled={busy !== null || draftInvalid}>
            {busy === "schedule" ? <LoaderCircle size={14} className="spin" /> : text("저장", "Save")}
          </button>
          {draft.enabled && draft.weekdays.length === 0 && (
            <small className="wide">{text("적용할 요일을 하나 이상 고르세요.", "Pick at least one day.")}</small>
          )}
          {draft.enabled && draft.start === draft.end && (
            <small className="wide">{text("시작과 끝이 같으면 시간대가 없습니다. 종일 돌리려면 스위치를 끄세요.", "Start and end are the same. Turn the switch off to run all day.")}</small>
          )}
        </div>
      </section>
    </Modal>
  );
}

export function UsageBudgetPanel({ active }: { active: boolean }) {
  const { text } = useI18n();
  const { confirm, confirmDialog } = useConfirm();
  const [snapshot, setSnapshot] = useState<UsageBudgetSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [defaultsDraft, setDefaultsDraft] = useState<UsageBudgetDefaults | null>(null);
  const [savingsDraft, setSavingsDraft] = useState<SavingsDraft | null>(null);
  // 페이싱 스케줄(제한 시간대) 초안. 스냅샷을 새로 읽을 때마다 저장값으로 되돌린다.
  const [quietDraft, setQuietDraft] = useState<QuietHours | null>(null);
  // 소비자의 트리거(반복 요청)까지 이 화면이 관리한다. 채팅 화면의 반복 요청 목록에는
  // 페이싱 워크플로 회차가 나오지 않으므로, 주기·활성·다음 실행이 여기서 보여야 한다.
  const [schedules, setSchedules] = useState<Map<string, ScheduledRequest>>(new Map());
  const [lastRuns, setLastRuns] = useState<Map<string, ScheduleRun>>(new Map());
  // 반복 요청별 최근 회차들. 마지막 한 건만 보면 "계속 초록인데 산출물이 없다"를 놓친다.
  const [recentRuns, setRecentRuns] = useState<Map<string, ScheduleRun[]>>(new Map());
  const [workflows, setWorkflows] = useState<SystemWorkflowSummary[]>([]);
  // 열려 있는 편집 모달. 예산 기본값·계정 풀은 한 개씩, 회차 편집은 소비자 id로 고른다.
  const [defaultsOpen, setDefaultsOpen] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [poolOpen, setPoolOpen] = useState(false);
  const [settingsFor, setSettingsFor] = useState<string | null>(null);
  /**
   * '직접 설정'을 고른 소비자 id. 이 값은 저장되는 설정이 아니라 레인 표를 여는 자리다 —
   * 저장본에서 '직접 설정'은 잡아 둔 레인이 하나라도 있다는 뜻이므로, 한 번도 잡은 적 없는
   * 회차는 표를 열지 못하면 성향 밖으로 나갈 길이 없다. 표에서 레인을 하나라도 잡으면
   * 저장본이 그 사실을 담아 이 상태가 없어도 '직접 설정'으로 선다.
   */
  const [customProfileFor, setCustomProfileFor] = useState<string | null>(null);
  // 새 회차 편집기를 열어 둔 워크플로 id(null이면 닫힘). 회차는 워크플로마다 하나이므로
  // 만드는 자리는 "회차 없는 워크플로" 행뿐이고, 그 행이 언제나 대상을 정해 준다.
  const [newTriggerFor, setNewTriggerFor] = useState<string | null>(null);
  // 패널이 좁은지. 좁으면 회차 카드의 상세정보를 기본으로 접는다.
  const panelRef = useRef<HTMLElement | null>(null);
  const [narrow, setNarrow] = useState(false);
  /**
   * 회차 카드의 상세정보를 펼칠지 접을지 사용자가 직접 뒤집은 것만 담는다. 여기 없는 카드는
   * 폭이 정하는 기본값(넓으면 펴짐, 좁으면 접힘)을 따른다 — 기본값을 상태에 미리 채워 두면
   * 창을 좁혔다 넓혔을 때 한 번도 건드리지 않은 카드까지 접힌 채로 남는다.
   */
  const [detailOverrides, setDetailOverrides] = useState<Record<string, boolean>>({});
  const detailOpen = (scheduleId: string) => detailOverrides[scheduleId] ?? !narrow;
  const toggleDetail = (scheduleId: string) =>
    setDetailOverrides((current) => ({ ...current, [scheduleId]: !(current[scheduleId] ?? !narrow) }));

  // 패널 폭을 재서 좁은지 판정한다. 창 크기뿐 아니라 옆 목록이 열고 닫힐 때도 폭이 바뀌므로
  // 뷰포트가 아니라 요소를 관찰한다. ResizeObserver가 없는 환경은 넓은 쪽(기본 펴짐)으로 둔다.
  useEffect(() => {
    const element = panelRef.current;
    if (!element || typeof ResizeObserver !== "function") return undefined;
    const sync = () => setNarrow(element.getBoundingClientRect().width <= NARROW_PANEL_WIDTH);
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  /**
   * 새 스냅샷을 화면에 반영한다. 초안 세 벌은 저장값을 그대로 비추는 자리라 스냅샷과 함께
   * 갱신해야 한다 — 한 벌만 갱신하면 화면의 값과 저장값이 다른데도 같아 보인다.
   * 30초 자동 재조회는 일부러 이걸 쓰지 않는다(편집 중인 초안을 덮어쓰면 안 된다).
   */
  const commitSnapshot = useCallback((next: UsageBudgetSnapshot) => {
    setSnapshot(next);
    setDefaultsDraft(next.defaults);
    setSavingsDraft(savingsDraftFrom(next.savings));
    setQuietDraft(quietDraftFrom(next.defaults));
    setError(null);
  }, []);

  /**
   * 소진 마감 안내. 지금 소진을 시작하지 않으면 그 크레딧은 만료로 사라지므로 한 번 알린다.
   * 백엔드가 이미 알린 크레딧에는 `actNow`를 내리지 않으므로 여기서는 확인 처리만 하면 된다 —
   * 스냅샷을 30초마다 다시 읽어도 같은 크레딧으로 다시 울리지 않는다.
   */
  useEffect(() => {
    if (!snapshot) return;
    const due = snapshot.accounts.find((account) => account.overview?.drain?.actNow === true);
    if (!due?.overview?.drain) return;
    const drain = due.overview.drain;
    const expires = drain.nextExpiresAt === null ? "" : ` ${new Date(drain.nextExpiresAt).toLocaleDateString()} 만료`;
    void showNativeNotification(
      "한도 리셋 크레딧 만료 임박",
      `${due.displayName}: 지금 소진 모드를 켜야 이 크레딧을 쓸 수 있습니다.${expires}`,
    ).catch(() => undefined);
    // 알림을 띄웠다는 사실만 남긴다. 실패해도 회차나 화면을 막지 않는다.
    void acknowledgeDrainNotice(due.accountId, drain.creditId).catch(() => undefined);
  }, [snapshot]);

  // 트리거 정보는 부가 정보다. 못 읽어도 예산 화면은 그대로 쓰이게 오류를 겹치지 않는다.
  // 스냅샷을 새로 읽을 때마다 같이 읽는다 — 소비자 행은 스냅샷의 활성 여부와 트리거의
  // 다음 실행을 한 줄에 놓으므로, 한쪽만 새로 읽으면 "비활성"인데 다음 실행이 뜨는 식으로 어긋난다.
  const loadTriggers = useCallback(async () => {
    try {
      const [scheduler, workflowList] = await Promise.all([getSchedulerSnapshot(), getSystemWorkflows()]);
      setSchedules(new Map(scheduler.schedules.map((schedule) => [schedule.id, schedule])));
      // 스냅샷의 runs는 최신순이라 첫 항목이 그 반복 요청의 최근 실행이다.
      const latest = new Map<string, ScheduleRun>();
      const recent = new Map<string, ScheduleRun[]>();
      for (const run of scheduler.runs) {
        if (!latest.has(run.scheduleId)) latest.set(run.scheduleId, run);
        const bucket = recent.get(run.scheduleId) ?? [];
        if (bucket.length < RECENT_ROUND_SAMPLE) bucket.push(run);
        recent.set(run.scheduleId, bucket);
      }
      setLastRuns(latest);
      setRecentRuns(recent);
      setWorkflows(workflowList.workflows);
    } catch {
      setSchedules(new Map());
      setLastRuns(new Map());
      setRecentRuns(new Map());
      setWorkflows([]);
    }
  }, []);

  const load = useCallback(async () => {
    setBusy("load");
    try {
      commitSnapshot(await getUsageBudget());
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(null);
    }
    await loadTriggers();
  }, [commitSnapshot, loadTriggers]);

  useEffect(() => {
    if (active) void load();
  }, [active, load]);

  // 회차는 이 화면 밖(AIA·워크플로 화면·다른 기기)에서도 멈추거나 켜진다. 탭이 열려 있는
  // 동안 조용히 다시 읽어 표시가 실제와 어긋난 채 남지 않게 한다. busy는 건드리지 않는다.
  useEffect(() => {
    if (!active) return undefined;
    const timer = window.setInterval(() => {
      void getUsageBudget().then(setSnapshot).catch(() => undefined);
      void loadTriggers();
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [active, loadTriggers]);

  // 성공 여부를 돌려준다 — 모달의 저장은 성공했을 때만 닫혀야 하고, 실패하면 입력을 든 채
  // 열려 있어야 다시 시도할 수 있다.
  const apply = useCallback(async (key: string, action: () => Promise<UsageBudgetSnapshot>) => {
    setBusy(key);
    let ok = false;
    try {
      commitSnapshot(await action());
      ok = true;
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(null);
    }
    await loadTriggers();
    return ok;
  }, [commitSnapshot, loadTriggers]);

  // 트리거 조작은 예산 스냅샷이 아니라 반복 요청을 바꾸므로, 성공 후 전체를 다시 읽는다.
  const triggerAction = useCallback(async (key: string, action: () => Promise<unknown>) => {
    setBusy(key);
    try {
      await action();
      setError(null);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(null);
    }
    await load();
  }, [load]);

  // 참여 계정은 워크플로 단위 설정이다. 같은 워크플로를 도는 소비자 행 어디서 바꿔도
  // 하나의 집합을 고친다. 빈 배열은 제한 해제(전역 풀 그대로).
  const setWorkflowAccounts = (consumer: UsageBudgetConsumer, accounts: string[]) => {
    const workflowId = consumer.workflowId;
    if (!workflowId) return;
    const pacingEnabled = workflows.find((workflow) => workflow.id === workflowId)?.pacingEnabled ?? true;
    void triggerAction(`workflow-accounts:${workflowId}`, () => setSystemWorkflowPacing({ workflowId, pacingEnabled, accounts }));
  };

  const removeTrigger = async (schedule: ScheduledRequest) => {
    const accepted = await confirm({
      title: text("페이싱 회차 삭제", "Delete paced round"),
      message: text(
        `'${schedule.name}' 반복 요청을 삭제할까요?\n회차와 소비자 설정(우선순위·상한)이 함께 지워집니다. 실측 이력은 남고, 같은 워크플로의 회차는 다시 만들 수 있습니다.`,
        `Delete the schedule '${schedule.name}'?\nThe round and its consumer settings (priority, ceilings) go away; measurements remain and the workflow can get a new round.`,
      ),
      confirmLabel: text("삭제", "Delete"),
      tone: "danger",
    });
    if (!accepted) return;
    await triggerAction(`trigger:${schedule.id}`, () => deleteScheduledRequest(schedule.id));
  };

  // 저장 중 표시(busy)의 키는 언제나 대상의 id다. 키와 payload를 여기서 함께 만들어 두면
  // 아래 조작들은 자기가 바꾸는 칸만 넘기면 된다.
  const saveAccount = (account: UsageBudgetAccount, patch: Partial<SetUsageBudgetAccountRequest>) =>
    apply(`account:${account.accountId}`, () => setUsageBudgetAccount(accountRequest(account, patch)));

  const saveConsumer = (consumer: UsageBudgetConsumer, patch: Partial<SetUsageBudgetConsumerRequest>) =>
    apply(`consumer:${consumer.scheduleId}`, () => setUsageBudgetConsumer(consumerRequest(consumer, patch)));

  const toggleAccount = (account: UsageBudgetAccount, pacingEnabled: boolean) =>
    saveAccount(account, { pacingEnabled });

  const setAccountTarget = (account: UsageBudgetAccount, raw: string) => {
    const targetPercent = parsePercent(raw);
    if (targetPercent === account.targetPercent) return;
    void saveAccount(account, { targetPercent });
  };

  const toggleConsumer = (consumer: UsageBudgetConsumer, enabled: boolean) =>
    saveConsumer(consumer, { enabled });

  const setConsumerPriority = (consumer: UsageBudgetConsumer, raw: string) => {
    const value = Number(raw);
    if (!Number.isFinite(value)) return;
    const priority = Math.min(100, Math.max(0, Math.round(value)));
    if (priority === consumer.priority && consumer.enabled !== null) return;
    void saveConsumer(consumer, { priority });
  };

  /**
   * 예산 기본값 모달의 저장. 목표·가드와 절감 목표는 백엔드 커맨드가 다르지만 한 모달의
   * 한 버튼으로 함께 저장한다 — 칸마다 저장 버튼을 두면 어느 버튼이 어느 칸을 담당하는지
   * 모달 안에서 알 수 없다. 두 커맨드를 잇달아 보내고 마지막 스냅샷으로 초안을 맞춘다.
   *
   * 백엔드에 두 벌을 한 번에 받는 커맨드가 없어 트랜잭션이 아니다. 그래서 첫 커맨드가 성공하고
   * 둘째가 실패하면 목표·가드는 이미 저장된 상태다 — 이때 화면이 저장 전 스냅샷을 비추면
   * 사용자는 아무것도 저장되지 않은 줄로 안다(QA #56). 첫 커맨드가 돌려준 스냅샷을 그대로
   * 반영하고, 오류는 "일부만 저장됨"이라고 구분해 말한다. 절감 초안은 그대로 두어 다시 저장을
   * 누르면 남은 절반만 이어서 저장된다(목표·가드는 같은 값을 다시 보내므로 해롭지 않다).
   */
  const saveDefaults = async () => {
    if (!defaultsDraft || !savingsDraft) return;
    // 스케줄은 저장된 값을 그대로 실어 보낸다 — 이 모달은 스케줄을 고치지 않는다.
    // 첫 커맨드의 결과를 클로저 밖으로 꺼내는 자리. 둘째가 실패했을 때만 쓴다.
    const partial: { snapshot: UsageBudgetSnapshot | null } = { snapshot: null };
    const saved = await apply("defaults", async () => {
      partial.snapshot = await setUsageBudgetPolicy(defaultsPayload(defaultsDraft, snapshot?.defaults.quietHours ?? null));
      try {
        return await setUsageBudgetSavings({
          targetReductionPercent: savingsDraft.targetReductionPercent ?? null,
          // 빈 칸은 기본값 5, 나머지는 백엔드가 받는 1~32로 자른다.
          baselineRuns: clampBaselineRuns(savingsDraft.baselineRuns ?? 5),
        });
      } catch (cause) {
        throw new Error(text(
          `일부만 저장됨: 기본 목표·가드는 저장됐지만 회당 소비 추이 설정은 저장되지 않았습니다. 다시 저장을 누르면 남은 값만 이어서 저장합니다. (${errorText(cause)})`,
          `Partially saved: the default target and guard were stored, but the cost-per-run trend settings were not. Press save again to store the remaining values. (${errorText(cause)})`,
        ));
      }
    });
    if (saved) {
      setDefaultsOpen(false);
      return;
    }
    // 절반만 저장된 경우: 목표·가드 쪽 저장본을 화면에 반영한다. 절감 초안은 사용자가 친 값을 지킨다.
    if (partial.snapshot !== null) {
      const actual = partial.snapshot;
      setSnapshot(actual);
      setDefaultsDraft(actual.defaults);
      setQuietDraft(quietDraftFrom(actual.defaults));
    }
  };

  /**
   * 모달을 열 때 초안을 저장값으로 되돌린다. 초안은 패널 상태에 살아 있어 모달을 닫아도
   * 지워지지 않는다 — 저장하지 않고 닫았다 다시 열면 방금 지운 입력이 그대로 남아, 화면의
   * 값과 실제 저장값이 다른데도 같아 보인다.
   */
  const openDefaults = () => {
    if (!snapshot) return;
    setDefaultsDraft(snapshot.defaults);
    setSavingsDraft(savingsDraftFrom(snapshot.savings));
    setDefaultsOpen(true);
  };

  /**
   * 회차 설정 모달을 연다·닫는다. '직접 설정'은 저장되지 않는 표시라 모달을 드나들 때
   * 저장본 쪽으로 되돌려야 한다 — 남겨 두면 레인을 하나도 잡지 않고 닫은 회차가 다음에 열 때도
   * 성향이 걸려 있지 않은 것처럼 보인다.
   */
  const openSettings = (scheduleId: string) => {
    setCustomProfileFor(null);
    setSettingsFor(scheduleId);
  };

  const closeSettings = () => {
    setCustomProfileFor(null);
    setSettingsFor(null);
  };

  const openSchedule = () => {
    if (!snapshot) return;
    setQuietDraft(quietDraftFrom(snapshot.defaults));
    setScheduleOpen(true);
  };

  const saveQuiet = async () => {
    if (!snapshot || !quietDraft) return;
    // 반대로 여기서는 예산 기본값의 저장된 값을 실어 보낸다 — 예산 기본값 모달의 미저장 초안을 끌어오지 않는다.
    const saved = await apply("schedule", () => setUsageBudgetPolicy(defaultsPayload(snapshot.defaults, quietDraft)));
    if (saved) setScheduleOpen(false);
  };
  /**
   * 페이싱 기능 전체 스위치. 저장은 예산 기본값과 같은 커맨드이고 백엔드가 기본값 한 벌을
   * 통째로 교체하므로, 저장된 기본값·스케줄을 그대로 싣고 이 칸만 바꿔 보낸다 — 열려 있는
   * 모달의 미저장 초안을 끌어오면 스위치 하나를 누른 것이 다른 값까지 저장한다.
   */
  const togglePacing = (enabled: boolean) => {
    if (!snapshot) return;
    void apply("pacing", () => setUsageBudgetPolicy(defaultsPayload({ ...snapshot.defaults, enabled }, snapshot.defaults.quietHours ?? null)));
  };
  const quietSummary = describeQuietHours(snapshot?.defaults.quietHours, text);

  /**
   * 레인 하나의 추론수준 설정을 바꿔 전체 맵을 다시 보낸다(백엔드는 주어진 맵으로 통째로 교체).
   * 고정을 걸면 자동 상한은 뜻이 없어 지우고, 둘 다 비면 항목을 없애 "자동·상한 없음"으로 돌린다.
   */
  const setLaneReasoningEffort = (consumer: UsageBudgetConsumer, provider: ProviderId, patch: LaneReasoningEffort) => {
    const current = consumer.reasoningEfforts ?? {};
    const lane: LaneReasoningEffort = { ...(current[provider] ?? {}), ...patch };
    const next: Partial<Record<ProviderId, LaneReasoningEffort>> = { ...current };
    if (lane.fixed) next[provider] = { fixed: lane.fixed, maxAuto: null, minAuto: null };
    else if (lane.maxAuto || lane.minAuto) next[provider] = { fixed: null, maxAuto: lane.maxAuto ?? null, minAuto: lane.minAuto ?? null };
    else delete next[provider];
    // 레인을 손으로 건드리면 '직접 설정'이다 — 프리셋이 그 위를 덮어쓰지 않게 성향을 비운다.
    void saveConsumer(consumer, { reasoningEfforts: next, spendProfile: null });
  };

  /**
   * 소비 성향을 바꾼다. 프리셋은 레인별 설정이 없는 공급자에만 적용되므로, 프리셋을 고르면
   * 손으로 잡아 둔 레인을 비워 준다 — 안 그러면 고른 성향이 아무 일도 하지 않은 것처럼 보인다.
   * '직접 설정'은 반대로 성향만 해제하고 레인 표를 열어 둔다(레인은 그 표에서 잡는다).
   * 두 경우 모두 성향에 `null`을 실어 보내야 해제된다 — 칸을 빼면 백엔드가 기존 값을 지킨다.
   */
  const setSpendProfile = (consumer: UsageBudgetConsumer, value: string) => {
    if (value === "custom") {
      setCustomProfileFor(consumer.scheduleId);
      void saveConsumer(consumer, { spendProfile: null });
      return;
    }
    setCustomProfileFor(null);
    void saveConsumer(consumer, {
      spendProfile: value === "inherit" ? null : (value as SpendProfile),
      reasoningEfforts: {},
    });
  };

  const setConsumerCeiling = (consumer: UsageBudgetConsumer, field: "maxTokensPerRun" | "maxCostPercentPerRun", raw: string) => {
    const trimmed = raw.trim();
    // 빈 입력은 상한 해제(0), 숫자는 그대로. 생략(undefined)은 기존 값 유지라 쓰지 않는다.
    const value = trimmed === "" ? 0 : Number(trimmed);
    if (!Number.isFinite(value) || value < 0) return;
    if ((consumer[field] ?? 0) === value) return;
    void saveConsumer(consumer, field === "maxTokensPerRun" ? { maxTokensPerRun: Math.round(value) } : { maxCostPercentPerRun: value });
  };

  const toggleEnforce = (consumer: UsageBudgetConsumer, enforceCeiling: boolean) =>
    saveConsumer(consumer, { enforceCeiling });

  const savingsLine = (report: UsageBudgetSavingsReport | undefined, provider: ProviderId): string | null => {
    if (!report) return null;
    const metric = report.metric === "tokens"
      ? text(`토큰 ${tokenCount(report.baselineTokens ?? 0)} → ${tokenCount(report.currentTokens ?? 0)}`, `tokens ${tokenCount(report.baselineTokens ?? 0)} → ${tokenCount(report.currentTokens ?? 0)}`)
      : report.metric === "costPercent"
        ? `${percent(report.baselineCostPercent, 2)}p → ${percent(report.currentCostPercent, 2)}p`
        : text(`기준선 수집 중 (${report.observations}회)`, `collecting baseline (${report.observations} runs)`);
    const achieved = report.achievedReductionPercent === null
      ? ""
      : report.achievedReductionPercent >= 0
        ? text(` · ${report.achievedReductionPercent.toFixed(0)}% 절감`, ` · ${report.achievedReductionPercent.toFixed(0)}% saved`)
        : text(` · ${Math.abs(report.achievedReductionPercent).toFixed(0)}% 증가`, ` · ${Math.abs(report.achievedReductionPercent).toFixed(0)}% more`);
    const goal = "";
    const ceiling = report.overCeiling ? text(` · 상한 초과(${report.overCeiling})`, ` · over ceiling (${report.overCeiling})`) : "";
    // 기준선이 확정된 뒤에야 달성률을 시점끼리 견줄 수 있다. 확정 전에는 그렇다고 말해 준다.
    const fixed = report.achievedReductionPercent === null
      ? ""
      : report.baselineFixedAt
        ? text(` · 기준선 ${formatDate(report.baselineFixedAt)} 확정`, ` · baseline fixed ${formatDate(report.baselineFixedAt)}`)
        : text(" · 기준선 미확정", " · baseline not fixed yet");
    return `${sourceName(provider)}: ${metric}${achieved}${goal}${ceiling}${fixed}`;
  };

  const providers: ProviderId[] = ["claude", "codex", "antigravity"];
  const pool = poolSummary(snapshot?.accounts ?? []);
  // 워크플로별 참여 계정의 선택지. 풀이 있으면 풀 안에서 고르고, 없으면 전 계정이 후보다.
  const accountPool = snapshot?.accounts.filter((account) => account.pacingEnabled) ?? [];
  const selectableAccounts = accountPool.length > 0 ? accountPool : snapshot?.accounts ?? [];
  // 소비자가 하나도 등록되지 않았으면 정책이 비어 있는 것이고, 그때는 모든 후보가 허용된다.
  const selectedConsumers = snapshot
    ? snapshot.consumers.filter((consumer) => consumer.enabled ?? !snapshot.selectionConfigured).length
    : 0;
  const settingsConsumer = settingsFor
    ? snapshot?.consumers.find((consumer) => consumer.scheduleId === settingsFor) ?? null
    : null;
  const selectableAccountIds = selectableAccounts.map((account) => account.accountId);
  // 저장소의 빈 집합은 "제한 없음"이다. 화면에서는 전부 켜진 것과 같으므로 후보 전체로 편다 —
  // 필드를 모르는 옛 백엔드 응답도 같은 규칙으로 읽힌다.
  const workflowAccountsUnrestricted = (settingsConsumer?.workflowAccounts ?? []).length === 0;
  const workflowAccountIds = workflowAccountsUnrestricted
    ? selectableAccountIds
    : selectableAccountIds.filter((id) => settingsConsumer!.workflowAccounts.includes(id));
  // 손으로 잡아 둔 레인. 하나라도 있으면 '직접 설정'이고 프리셋은 그 위를 덮지 않는다.
  const laneOverrides = Object.keys(settingsConsumer?.reasoningEfforts ?? {});
  /**
   * '직접 설정'으로 서 있는지. 잡아 둔 레인이 있으면 저장본이 그렇게 말하고, 방금 셀렉트에서
   * 고른 회차는 아직 레인이 없어도 그렇다 — 레인을 잡을 표가 이때만 열리기 때문이다.
   */
  const laneEditorOpen = laneOverrides.length > 0
    || (settingsConsumer !== null && customProfileFor === settingsConsumer.scheduleId);
  const spendProfileLabel = (profile: SpendProfile | null | undefined): string | null => {
    switch (profile) {
      case "saver": return text("아껴쓰기", "saver");
      case "goal": return text("균형", "balanced");
      case "quality": return text("품질 우선", "quality first");
      default: return null;
    }
  };
  const defaultProfileLabel = spendProfileLabel(snapshot?.defaults.spendProfile);
  /**
   * 성향 셀렉트 아래 한 줄. 레인을 직접 잡아 둔 회차와 방금 성향을 해제한 회차는 레인 표가
   * 무엇을 하는지 먼저 말해 주고, 그 밖에는 지금 걸린 성향(없으면 물려받은 기본값)을 풀어 준다.
   */
  const spendProfileHint = (() => {
    if (laneOverrides.length > 0) {
      return text(
        `공급자 ${laneOverrides.length}곳을 직접 잡아 두었습니다. 성향을 고르면 그 설정이 지워지고 성향이 천장·바닥을 대신 잡습니다.`,
        `${laneOverrides.length} provider lane(s) are set by hand. Picking a profile clears them and lets the profile set the cap and floor.`,
      );
    }
    if (laneEditorOpen) {
      return text(
        "성향을 해제했습니다. 아래 표에서 잡은 공급자만 그 값을 쓰고, 하나도 잡지 않으면 다시 '기본값 따름'으로 섭니다.",
        "The profile is cleared. Only the lanes you set below use those values; set none and it falls back to following the default.",
      );
    }
    switch (settingsConsumer?.spendProfile ?? snapshot?.defaults.spendProfile) {
      case "goal":
        return text("medium~high 사이에서 회전을 최대로 하는 등급으로 돕니다. 남는 예산이 있을 때만 올라갑니다.", "Runs between medium and high at whatever keeps the most rounds going, rising only when budget would otherwise expire.");
      case "saver":
        return text("항상 최저 등급으로 돕니다. 검증 게이트가 품질을 지키는 회차에 맞습니다.", "Always runs at the lowest rung. Fits rounds whose verification gate protects quality.");
      case "quality":
        return text("여력이 있으면 높은 등급으로 돕니다. 회당 소비가 서너 배까지 오를 수 있습니다.", "Runs high when headroom allows. Cost per run can be three to four times the lowest rung.");
      default:
        return text("성향을 정하지 않으면 경계 없이 회전을 최대로 하는 등급을 고릅니다.", "Without a profile the planner maximizes rounds with no bounds.");
    }
  })();

  // 추론수준 레인 = 이 회차가 쓰는 계정들의 공급자. 계정을 못 읽는 상태면 세 공급자를 다 보인다.
  const effortLaneProviders = EFFORT_LANE_ORDER.filter((provider) =>
    selectableAccounts.some((account) => account.provider === provider && workflowAccountIds.includes(account.accountId)));
  const effortLanes = effortLaneProviders.length > 0 ? effortLaneProviders : EFFORT_LANE_ORDER;
  const effortLadder = (provider: ProviderId) => snapshot?.reasoningEffortLadders?.[provider] ?? FALLBACK_EFFORT_LADDERS[provider];
  const pacingWorkflows = workflows.filter((workflow) => workflow.pacingEnabled);
  // 회차(이 워크플로를 돌리는 반복 요청)가 아직 없는 페이싱 워크플로. 새 회차 생성은 이들에게만
  // 연다 — 회차가 있는 워크플로에 트리거를 하나 더 달면 같은 작업이 두 소비자로 갈라져 서로
  // 예산을 경쟁하고, 백엔드도 저장을 거절한다.
  // 반복 요청이 이미 지워진 소비자 설정은 회차로 세지 않는다 — 삭제한 회차의 찌꺼기 설정이
  // 남아 있다고 새 회차를 못 만들면 그 워크플로는 영영 돌지 않는다.
  const roundlessWorkflows = pacingWorkflows.filter((workflow) =>
    !(snapshot?.consumers ?? []).some((consumer) => consumer.workflowId === workflow.id && consumer.scheduleExists));

  // 소진 모드 현황. 토글은 전역이지만 실제로 몰아 쓰는 계정은 쓸 수 있는 리셋 크레딧이 남은
  // 쪽뿐이라, 켜 두고도 아무 계정도 소진하지 않는 상태가 정상적으로 생긴다. 카드가 그 차이를
  // 말해 주지 않으면 켰는데 왜 그대로인지 알 수 없다.
  // 페이싱 기능 전체 스위치의 현재 값. 저장본에 칸이 없으면(이 스위치보다 오래된 정책)
  // 켜진 것으로 읽는다 — 백엔드의 기본값과 같아야 화면과 실제 동작이 어긋나지 않는다.
  const pacingOn = snapshot?.defaults.enabled ?? true;
  const drainOn = snapshot?.defaults.drain === true;
  const drainReserve = snapshot?.defaults.drainReserveCredits ?? 0;
  const pacedAccounts = (snapshot?.accounts ?? []).filter((account) => account.pacingEnabled);
  const drainingAccounts = pacedAccounts.filter((account) => account.overview?.drain?.spendable === true);
  // 크레딧은 있지만 남겨 둘 몫이라 손대지 않는 계정.
  const drainHeldAccounts = pacedAccounts.filter((account) =>
    account.overview?.drain?.spendable === false && (account.overview?.drain?.availableCount ?? 0) > 0);
  // 가장 이른 "이때까진 시작해야 한다" 시각. 실측이 없으면 계산되지 않아 비어 있다.
  const drainActBy = drainingAccounts
    .map((account) => account.overview?.drain?.actByAt ?? null)
    .filter((at): at is number => at !== null)
    .sort((a, b) => a - b)[0] ?? null;

  return (
    <>
      <section className="panel workflow-overview recurring-overview">
        <div className="workflow-overview-copy">
          <span className="workflow-overview-icon" aria-hidden="true"><Gauge size={21} /></span>
          <div>
            <span className="workflow-eyebrow">WORKFLOW PACING</span>
            <h2>{text("워크플로 페이싱", "Workflow pacing")}</h2>
          <p>
            {text(
              "페이싱 대상 워크플로가 나눠 쓸 계정, 참여 반복 요청, 회차별 예산을 관리합니다. 대상 워크플로는 계약이 정합니다 — 사용량을 쓰는 계약이면 대상입니다.",
              "Manage the accounts, participating requests, and per-round budgets of paced workflows. The contract decides which workflows are paced: any contract that consumes usage.",
            )}
          </p>
          </div>
        </div>
        <div className="workflow-overview-actions">
          {/* 기능 전체를 켜고 끄는 자리. 스케줄(시간대)·계정·회차는 각각 자기 자리에서 끄지만,
              "지금은 아무것도 자동으로 돌리지 마라"를 한 번에 말할 곳이 없었다. */}
          <div className={`workflow-pacing-control${pacingOn ? "" : " unavailable"}`} data-ui-anchor="workflows.usage-budget.enabled">
            <Gauge size={13} aria-hidden="true" />
            <span>{text("페이싱 사용", "Pacing")}</span>
            <em>{pacingOn ? text("켜짐", "on") : text("꺼짐", "off")}</em>
            <AppToggle
              checked={pacingOn}
              disabled={!snapshot || busy !== null}
              label={text("워크플로 페이싱 사용", "Use workflow pacing")}
              onChange={togglePacing}
            />
          </div>
          <button className="button" type="button" onClick={openSchedule} disabled={!snapshot} data-ui-anchor="workflows.usage-budget.schedule" title={text("페이싱 스케줄", "Pacing schedule")}>
            <CalendarClock size={14} /> {text("스케줄", "Schedule")}
            {quietSummary && <small>{quietSummary}</small>}
          </button>
          <button className="icon-button" type="button" onClick={() => void load()} disabled={busy !== null} aria-label={text("새로고침", "Refresh")} title={text("새로고침", "Refresh")}>
            {busy === "load" ? <LoaderCircle size={15} className="spin" /> : <RefreshCw size={15} />}
          </button>
        </div>
        <dl className="workflow-overview-stats five">
          <Metric label={text("페이싱 워크플로", "Pacing workflows")} value={snapshot?.pacingWorkflowIds.length ?? 0} note={text("개", "")} />
          <Metric label={text("페이싱 계정", "Pacing accounts")} value={pool.pooled} note={` / ${pool.total}`} />
          <Metric label={text("참여 반복 요청", "Participating requests")} value={selectedConsumers} note={` / ${snapshot?.consumers.length ?? 0}`} />
          <Metric label={text("지금 도는 회차", "Rounds running")} value={snapshot?.activeConsumers.length ?? 0} note={text("개", "")} />
          <Metric
            className="workflow-limit-summary"
            label={<><ChartPie size={13} /> {text("예산·회차 주기", "Budget and cadence")}</>}
            value={snapshot ? budgetSummary(snapshot, text) : text("예산 확인 중", "Loading budget")}
          />
        </dl>
      </section>

      <section className="settings-card usage-budget-panel" data-ui-anchor="workflows.usage-budget" ref={panelRef}>
        <header>
          <div>
            <span>{text("사용량", "Usage")}</span>
            <h2>{text("사용량 예산", "Usage budget")}</h2>
          </div>
          <p>
            {text(
              "현재 값은 카드에서 읽고, 설정은 각 카드의 편집 버튼에서 바꿉니다.",
              "Cards show the current state; each card's edit button changes it.",
            )}
          </p>
          <button className="button" type="button" onClick={openDefaults} disabled={!snapshot}>
            <Settings size={14} /> {text("예산 기본값", "Budget defaults")}
          </button>
        </header>
        {error && <ErrorBanner message={error} />}
        {snapshot && !pacingOn && (
          <div className="usage-budget-pacing-off" role="status">
            <PauseCircle size={15} aria-hidden="true" />
            <span>
              <strong>{text("워크플로 페이싱 꺼짐", "Workflow pacing is off")}</strong>
              <small>
                {text(
                  "페이싱 회차가 예약 시각이 되어도 뜨지 않습니다. 계정 풀·회차·예산 설정은 그대로 남아 다시 켜면 이어지고, 회차 카드의 [지금 실행]은 꺼져 있어도 나갑니다.",
                  "Paced rounds do not launch when their scheduled time arrives. The account pool, rounds, and budgets stay as they are and resume when you switch pacing back on; a card's Run now still launches.",
                )}
              </small>
            </span>
          </div>
        )}
        {snapshot && drainOn && (
          <div className="usage-budget-drain-status" role="status">
            <Gauge size={15} aria-hidden="true" />
            <span>
              <strong>
                {drainingAccounts.length > 0
                  ? text(`소진 모드 켜짐 · 계정 ${drainingAccounts.length}개가 몰아 쓰는 중`, `Drain mode on · draining ${drainingAccounts.length} account(s)`)
                  : text("소진 모드 켜짐 · 지금 소진 중인 계정 없음", "Drain mode on · no account is draining")}
              </strong>
              <small>
                {drainingAccounts.length > 0
                  ? text(
                    "채울 창을 짧은 창 상한이 허락하는 만큼 몰아 쓰고, 창이 비면 한도 리셋 크레딧을 한 장 써서 되돌린 뒤 다시 채웁니다. 페이싱 스케줄은 그대로 지킵니다.",
                    "Fills as fast as the guard cap allows, then spends one rate limit reset credit to restore the emptied window and fills it again. The pacing schedule still applies.",
                  )
                  : drainHeldAccounts.length > 0
                    ? text(
                      `남은 리셋 크레딧이 남겨 둘 장수(${drainReserve}장)뿐이라 ${drainHeldAccounts.length}개 계정을 건드리지 않고 균등 소비로 돕니다.`,
                      `Only the reserved credits (${drainReserve}) remain, so ${drainHeldAccounts.length} account(s) stay on even pacing.`,
                    )
                    : text(
                      "쓸 수 있는 한도 리셋 크레딧이 있는 계정이 없어 모두 균등 소비로 돕니다. 되돌릴 수단 없이 한도만 일찍 태우면 남은 기간 내내 그 계정이 멈추기 때문입니다.",
                      "No account has a spendable reset credit, so all stay on even pacing — draining with no way back would strand them for the rest of the period.",
                    )}
                {drainActBy !== null && ` · ${text("가장 이른 크레딧 마감", "Earliest credit deadline")} ${new Date(drainActBy).toLocaleDateString()}`}
                {drainingAccounts.length > 0 && drainReserve > 0
                  && ` · ${text(`${drainReserve}장은 남겨 둡니다`, `keeping ${drainReserve} in reserve`)}`}
              </small>
            </span>
          </div>
        )}
        {snapshot && (
          <div className="settings-card-sections">
            <AccountPoolSection snapshot={snapshot} pool={pool} busy={busy} onOpenPool={() => setPoolOpen(true)} />

            <section className="settings-subsection" data-ui-anchor="workflows.usage-budget.consumers">
              <header>
                <div>
                  {/* 기동 조건과 우선순위 배분 규칙은 물음표 동그라미 팝오버로 접어 둔다. */}
                  <strong>
                    {text("페이싱 회차", "Paced rounds")}
                    <HelpHint
                      label={text("페이싱 회차 기동 및 우선순위 안내", "About paced round execution and priorities")}
                      title={text("페이싱 회차 기동 및 우선순위", "Paced round execution & priorities")}
                    >
                      {snapshot.selectionConfigured
                        ? text("페이싱을 켠 워크플로를 돌리는 반복 요청만 여기 올라오고, 그중 켜진 것만 기동을 받습니다. 우선순위 숫자가 낮을수록(0이 가장 높음) 먼저 배분되고, 같은 값끼리는 번갈아 받습니다.", "Only requests running a pacing-enabled workflow appear here, and only the enabled ones receive runs. Lower priority numbers are served first (0 is highest); equal priorities alternate.")
                        : text("아직 등록된 소비자가 없어 페이싱을 켠 워크플로를 돌리는 모든 반복 요청이 허용됩니다. 하나라도 켜면 선택이 시작됩니다.", "No consumer is registered yet, so every schedule of a pacing-enabled workflow is allowed. Enable one to start selecting.")}
                    </HelpHint>
                  </strong>
                  <small>
                    {snapshot.selectionConfigured
                      ? text("페이싱 대상 반복 요청의 우선순위와 기동 상태를 관리합니다.", "Manage priorities and execution of paced schedules.")
                      : text("아직 등록된 소비자가 없어 모든 반복 요청이 허용됩니다.", "No consumer is registered yet; all schedules are allowed.")}
                  </small>
                </div>
              </header>
              <div className="usage-budget-cards">
                {/* 회차 주기·활성 및 미생성 워크플로 관리 안내도 물음표 동그라미로 배치한다. */}
                <div className="usage-budget-trigger-toolbar">
                  <small>
                    <span>{text("회차 운영 안내", "Round operation")}</span>
                    <HelpHint
                      label={text("회차 주기 및 활성 관리 안내", "About round cadence and activation")}
                      title={text("회차 운영 안내", "Round operation guide")}
                    >
                      {text(
                        "회차의 주기·활성은 여기서 관리하며, 채팅 화면의 반복 요청 목록에는 나오지 않습니다. 회차는 워크플로마다 하나이고, 회차가 없는 워크플로는 목록 아래에 행으로 드러나 거기서 만듭니다.",
                        "Round cadence and on/off live here; they do not appear in the chat screen's schedule list. Each workflow has at most one round, and a workflow without one shows up as a row below where you create it.",
                      )}
                    </HelpHint>
                  </small>
                </div>
                {snapshot.consumers.filter((consumer) => consumer.scheduleExists).map((consumer) => {
                  const isActive = snapshot.activeConsumers.includes(consumer.scheduleId);
                  const trigger = schedules.get(consumer.scheduleId) ?? null;
                  const lastRun = lastRuns.get(consumer.scheduleId) ?? null;
                  const tally = recentRoundTally(recentRuns.get(consumer.scheduleId));
                  const runActive = Boolean(lastRun && (lastRun.status === "running" || isWaitingRunStatus(lastRun.status)));
                  const runQueued = Boolean(trigger?.manualRunRequestedAt) && !runActive;
                  // 일시정지 여부는 스냅샷과 트리거 어느 한쪽이라도 꺼져 있으면 꺼진 것으로 본다.
                  // 두 값은 같은 반복 요청에서 나오지만 읽은 시점이 다를 수 있어, 한쪽만 보면
                  // "비활성" 배지 옆에 다음 실행 시각이 남는다.
                  const triggerPaused = consumer.scheduleEnabled === false || trigger?.enabled === false;
                  const summary = consumerSummary(consumer, snapshot.accounts);
                  const label = consumer.name ?? consumer.label ?? consumer.scheduleId;
                  const accountCostGroups = groupAccountCosts(consumer.costs?.perAccount ?? []);
                  const accountCostCount = accountCostGroups.reduce((count, group) => count + group.costs.length, 0);
                  const effortCosts = consumer.costs?.perEffort ?? [];
                  const effortGroups = groupEffortCosts(effortCosts);
                  // 처리량은 같은 계정 범위를 공유하는 회차 그룹별 판정이다. 현재 카드의
                  // 권장값만 골라 보여 무관한 워크플로를 조정 대안으로 섞지 않는다.
                  const throughput = consumer.throughput ?? null;
                  const ownThroughput = throughput?.rounds.find((round) => round.scheduleId === consumer.scheduleId) ?? null;
                  const detailsOpen = detailOpen(consumer.scheduleId);
                  const detailsId = `usage-budget-details-${consumer.scheduleId}`;
                  // 접혀 있을 때도 무엇이 접혀 있는지는 알려야 한다 — 접힌 칸의 값 몇 개를
                  // 토글 줄에 요약해, 펴 볼 이유가 없으면 펴지 않아도 되게 한다.
                  const detailSummary = [
                    text(`평균 소진율 ${percent(summary.averageUsedPercent, 0)}`, `avg used ${percent(summary.averageUsedPercent, 0)}`),
                    summary.remainingRuns === null
                      ? text("남은 예산 미측정", "budget not measured")
                      : text(`남은 예산 약 ${summary.remainingRuns}회`, `≈ ${summary.remainingRuns} runs left`),
                    accountCostCount > 1 ? text(`계정별 소비 ${accountCostCount}개`, `${accountCostCount} account costs`) : null,
                    tally ? text(`최근 ${tally.worked + tally.rested}회차 중 일함 ${tally.worked}`, `${tally.worked}/${tally.worked + tally.rested} rounds worked`) : null,
                  ].filter(Boolean).join(" · ");
                  return (
                    <article className={`usage-budget-card${consumer.enabled === false ? " muted" : ""}`} key={consumer.scheduleId} data-schedule-id={consumer.scheduleId}>
                      <div className="usage-budget-card-head">
                        <div>
                          <strong>
                            {/* 활성·비활성은 이 카드를 읽을지 말지를 먼저 가르는 값이라 제목 왼쪽에 둔다.
                                제목 오른쪽에 두면 이름 길이에 따라 배지 위치가 카드마다 달라져 훑기 어렵다. */}
                            {isActive && <em className="skill-sync-pill on">{text("활성", "active")}</em>}
                            {triggerPaused && <em className="skill-sync-pill partial">{text("비활성", "inactive")}</em>}
                            {label}
                            {consumer.paced === false && <em className="skill-sync-pill partial">{text("페이싱 미사용 · 기동만 통제", "unpaced · launch gate only")}</em>}
                            {workflows.find((workflow) => workflow.id === consumer.workflowId)?.pacingMode === "contract" && <em className="skill-sync-pill partial">{text("계약 내 페이싱 · 구형", "in-contract pacing · legacy")}</em>}
                          </strong>
                          <small>
                            {consumer.workflowId ?? "–"}
                            {` · ${text(`참여 계정 ${summary.accountCount}개`, `${summary.accountCount} account(s)`)}`}
                            {` · ${text(`우선순위 ${consumer.priority}`, `priority ${consumer.priority}`)}`}
                            {laneEffortSummary(consumer, text)}
                            {consumer.enabled === false ? ` · ${text("참여 꺼짐", "not participating")}` : ""}
                          </small>
                        </div>
                      </div>
                      <dl className="usage-budget-metrics" aria-label={text("기본 정보", "Basic info")}>
                        <Metric
                          label={text("반복주기", "Cadence")}
                          value={cadenceLabel(consumer.cadenceMinutes, text)}
                          note={<>
                            {trigger?.recurrence.frequency === "auto" ? text("자동 계산", "auto") : text("고정 주기", "fixed")}
                            {(trigger?.workflow?.pacing?.maxRuns ?? 1) > 1 ? text(` · 병렬 ${trigger?.workflow?.pacing?.maxRuns}건`, ` · ${trigger?.workflow?.pacing?.maxRuns} parallel`) : ""}
                          </>}
                        />
                        <Metric
                          label={text("다음 실행", "Next run")}
                          // 페이싱이 꺼져 있으면 저장된 다음 실행 시각은 발화하지 않는 값이다.
                          // 그대로 두면 지난 시각이 "다음 실행"으로 남아 회차가 밀린 것처럼 보인다.
                          value={!trigger ? "–" : triggerPaused ? text("일시정지", "paused") : !pacingOn ? text("페이싱 꺼짐", "pacing off") : formatRelative(trigger.nextRunAt)}
                          note={<>
                            {/* 페이싱이 꺼져 있으면 제한 시간대가 열려도 발화하지 않는다. 본값이 "페이싱 꺼짐"인데
                                보조줄이 "제한 시간대 대기"를 말하면 시간대만 지나면 다시 도는 줄로 읽힌다. */}
                            {pacingOn && snapshot.quietStatus?.blocked && trigger && !triggerPaused ? `${text("제한 시간대 대기", "waiting for quiet hours")} · ` : ""}
                            {trigger?.workflow ? describeScheduleWorkflow(trigger.workflow, workflows) : "–"}
                          </>}
                        />
                        <Metric
                          label={text("최근 실행", "Last run")}
                          value={lastRun ? (roundOutcomeText(lastRun, text) ?? runStatusText(lastRun.status, text)) : "–"}
                          note={<>
                            {lastRun && roundOutcomeText(lastRun, text) ? `${runStatusText(lastRun.status, text)} · ` : ""}
                            {text(`기록 ${consumer.costs?.recordedRuns ?? 0}건`, `${consumer.costs?.recordedRuns ?? 0} recorded`)}
                          </>}
                        />
                      </dl>
                      {throughput && ownThroughput && !throughput.reachesTarget && (
                        <p className="usage-budget-throughput-warning">
                          <AlertTriangle size={13} aria-hidden />
                          <span>
                            <strong>{text("이 회차 설정으로는 목표를 못 채웁니다.", "This round setup will not reach the target.")}</strong>{" "}
                            {text(
                              `이 회차의 계정 범위는 리셋까지 시간당 ${throughput.demandPercentPerHour.toFixed(1)}%p를 써야 하는데, 같은 계정을 쓰는 활성 회차 ${throughput.rounds.length}개가 내는 건 ${throughput.supplyPercentPerHour.toFixed(1)}%p입니다.`,
                              `This round's account scope must consume ${throughput.demandPercentPerHour.toFixed(1)}%p/h before reset, but its ${throughput.rounds.length} active round(s) deliver ${throughput.supplyPercentPerHour.toFixed(1)}%p/h.`,
                            )}{" "}
                            {ownThroughput.recommendedMaxRuns === null
                              ? text(
                                  "이 회차의 회당 소비를 아직 재지 못해 필요한 병렬 건수를 계산할 수 없습니다. 목표 소진율을 낮추거나 같은 계정을 쓰는 다른 회차를 조정하세요.",
                                  "This round's cost per run is not measured yet, so the required parallel count cannot be computed. Lower the target or adjust another round using the same accounts.",
                                )
                              : text(
                                  `이 회차를 병렬 ${ownThroughput.recommendedMaxRuns}건으로 올리면 채웁니다.`,
                                  `Raising this round to ${ownThroughput.recommendedMaxRuns} parallel runs covers it.`,
                                )}
                          </span>
                        </p>
                      )}
                      {/* 상세정보는 "이 회차가 지금 어떤 상태인가"를 읽은 다음에 보는 값들이다. 좁은 폭에서는
                          이만큼이 세로로 쌓여 카드 하나가 화면을 넘기므로 처음부터 접어 둔다. */}
                      <button
                        className="usage-budget-detail-toggle"
                        type="button"
                        aria-expanded={detailsOpen}
                        aria-controls={detailsId}
                        onClick={() => toggleDetail(consumer.scheduleId)}
                      >
                        {detailsOpen ? <ChevronDown size={13} aria-hidden /> : <ChevronRight size={13} aria-hidden />}
                        {text("상세정보", "Details")}
                        <small>{detailSummary}</small>
                      </button>
                      {detailsOpen && (
                        <div className="usage-budget-card-details" id={detailsId}>
                          <dl className="usage-budget-metrics" aria-label={text("상세 정보", "Detailed info")}>
                            {tally && (
                              <Metric
                                label={text(`최근 ${tally.worked + tally.rested}회차`, `Last ${tally.worked + tally.rested} rounds`)}
                                title={text(
                                  "회차 봉투는 기동이 0건이어도 성공으로 끝납니다. 실행 목록이 전부 완료로 보여도 실제로 일한 회차는 이 값입니다.",
                                  "A round envelope succeeds even when it launches nothing. The run list shows all of them as completed; this is how many actually did work.",
                                )}
                                value={text(`일함 ${tally.worked} · 쉼 ${tally.rested}`, `${tally.worked} worked · ${tally.rested} rested`)}
                                note={text(`기동 합계 ${tally.launched}건`, `${tally.launched} launched in total`)}
                              />
                            )}
                            {consumer.nextRun && (
                              <Metric
                                label={text("다음 실행 계정", "Next run accounts")}
                                title={text(
                                  "다음 회차를 지금 사용량으로 미리 계산한 결과입니다. 회차가 뜰 때 사용량이 달라지면 배정도 달라집니다.",
                                  "Computed now from current usage. The assignment changes if usage changes before the round starts.",
                                )}
                                value={triggerPaused
                                  ? text("일시정지", "paused")
                                  : consumer.nextRun.runs.length === 0 ? text("없음", "none") : nextRunAccountsLabel(consumer.nextRun.runs, snapshot.accounts, text)}
                                note={triggerPaused
                                  // 멈춘 회차는 주기 역조회가 안 되어 미리보기가 "주기를 찾을 수 없음"으로 끝난다. 그 문구 대신 상태를 말한다.
                                  ? text("켜면 다시 계산", "recomputed when enabled")
                                  : consumer.nextRun.runs.length === 0
                                    ? (consumer.nextRun.note ?? text("이번 회차 기동 없음", "nothing launches this round"))
                                    : text(`${consumer.nextRun.runs.reduce((sum, run) => sum + run.count, 0)}건 예정 · 추정`, `${consumer.nextRun.runs.reduce((sum, run) => sum + run.count, 0)} run(s) · estimate`)}
                              />
                            )}
                            <Metric label={text("평균 소진율", "Average used")} value={percent(summary.averageUsedPercent, 0)} note={snapshot.windowLabel} />
                            {summary.costs.length === 0 && (
                              <Metric label={text("회당 소비", "Cost per run")} value="–" note={text("실측 없음", "not measured")} />
                            )}
                            {summary.costs.map((cost) => (
                              <Metric
                                key={cost.provider}
                                label={cost.tokens === null ? text("회당 소비", "Cost per run") : text("회당 토큰", "Tokens per run")}
                                value={cost.tokens === null ? `${percent(cost.percentPerRun, 2)}p` : tokenCount(cost.tokens)}
                                note={<>{sourceName(cost.provider)}{cost.tokens !== null && cost.percentPerRun !== null ? ` · ${percent(cost.percentPerRun, 2)}p` : ""}</>}
                              />
                            ))}
                            <Metric
                              label={text("남은 예산", "Remaining budget")}
                              title={text(
                                "참여 계정의 순여유를 실측 회당 소비로 나눈 추정치입니다. 다른 회차가 같은 계정을 쓰면 줄어듭니다.",
                                "Estimated from the participating accounts' net headroom divided by the measured cost per run. Other rounds sharing the same accounts reduce it.",
                              )}
                              value={summary.remainingRuns === null ? "–" : text(`약 ${summary.remainingRuns}회`, `≈ ${summary.remainingRuns} runs`)}
                              note={text("추정", "estimate")}
                            />
                          </dl>
                          {effortCosts.length > 0 && (
                            // 등급 하나가 회당 소비를 서너 배까지 벌린다. 계정별 소비와 같은
                            // 관측을 등급으로 갈라, 한 칸 올리고 내릴 때의 값을 눈으로 견주게 한다.
                            <section className="usage-budget-agent-costs" aria-label={text("추론수준별 회당 소비", "Cost per run by effort")}>
                              <header>
                                <strong>{text("추론수준별 회당 소비", "Cost per run by effort")}</strong>
                                <small>{text(`${effortCosts.length}개 등급`, `${effortCosts.length} levels`)}</small>
                              </header>
                              <div className="usage-budget-agent-cost-groups">
                                {effortGroups.map((group) => (
                                  <section className={`usage-budget-agent-cost-group source-${group.provider}`} key={group.provider}>
                                    <header>
                                      <SourceBadge source={group.provider} />
                                      <span>{text(`${group.costs.length}개`, `${group.costs.length} levels`)}</span>
                                    </header>
                                    <ul>
                                      {group.costs.map((cost) => (
                                        <li key={`${cost.provider}:${cost.reasoningEffort}`}>
                                          <em>{reasoningLabel(cost.reasoningEffort)}</em>
                                          <dl>
                                            <Metric label={text("토큰", "Tokens")} value={cost.tokensPerRun === null ? "–" : tokenCount(cost.tokensPerRun)} />
                                            <Metric
                                              label={text("소비", "Usage")}
                                              value={cost.percentPerRun === null ? "–" : `${percent(cost.percentPerRun, 2)}p`}
                                            />
                                            <Metric label={text("실행", "Runs")} value={text(`${cost.runs}회`, `${cost.runs} runs`)} />
                                          </dl>
                                        </li>
                                      ))}
                                    </ul>
                                  </section>
                                ))}
                              </div>
                            </section>
                          )}
                          {accountCostCount > 1 && (
                            // 여러 계정(에이전트)으로 돈 회차는 계정마다 회당 토큰·소비를 따로 보여 준다.
                            // 한 계정뿐이면 위 공급자별 값과 같아 겹쳐 그리지 않는다. 여러 계정은
                            // 공급자별로 묶고 수치 열을 고정해 긴 이메일이 옆 값을 밀어내지 않게 한다.
                            <section className="usage-budget-agent-costs" aria-label={text("계정별 회당 소비", "Cost per run by account")}>
                              <header>
                                <strong>{text("계정별 회당 소비", "Cost per run by account")}</strong>
                                <small>{text(`${accountCostCount}개 계정`, `${accountCostCount} accounts`)}</small>
                              </header>
                              <div className="usage-budget-agent-cost-groups">
                                {accountCostGroups.map((group) => (
                                  <section className={`usage-budget-agent-cost-group source-${group.provider}`} key={group.provider}>
                                    <header>
                                      <SourceBadge source={group.provider} />
                                      <span>{text(`${group.costs.length}개`, `${group.costs.length} accounts`)}</span>
                                    </header>
                                    <ul>
                                      {group.costs.map((cost) => {
                                        const account = snapshot.accounts.find((item) => item.accountId === cost.accountId);
                                        const accountName = account ? accountLabel(account) : cost.accountId;
                                        return (
                                          <li key={`${cost.provider}:${cost.accountId}`}>
                                            <em title={accountName}>{accountName}</em>
                                            <dl>
                                              <Metric label={text("토큰", "Tokens")} value={cost.tokensPerRun === null ? "–" : tokenCount(cost.tokensPerRun)} />
                                              <Metric
                                                label={text("소비", "Usage")}
                                                value={cost.percentPerRun === null ? "–" : `${percent(cost.percentPerRun, 2)}p`}
                                              />
                                              <Metric label={text("실행", "Runs")} value={text(`${cost.runs}회`, `${cost.runs} runs`)} />
                                            </dl>
                                          </li>
                                        );
                                      })}
                                    </ul>
                                  </section>
                                ))}
                              </div>
                            </section>
                          )}
                          {providers.map((provider) => {
                            const line = savingsLine(consumer.costs?.savings?.[provider], provider);
                            return line ? <small className="usage-budget-savings-line" key={provider}>{line}</small> : null;
                          })}
                        </div>
                      )}
                      {/* 편집은 되돌릴 수 있는 조작이라 지우기 바로 왼쪽에 둔다. 실행·정지는
                          트리거를 읽었을 때만 걸 수 있고, 편집은 트리거를 못 읽어도 열린다. */}
                      <div className="usage-budget-card-actions">
                        {trigger && (<>
                          <button
                            className="button"
                            type="button"
                            disabled={busy !== null || runActive || runQueued}
                            onClick={() => void triggerAction(`trigger:${trigger.id}`, () => runScheduledRequestNow(trigger.id))}
                          >
                            {runActive ? runStatusText(lastRun!.status, text) : runQueued ? text("실행 요청됨", "Run requested") : text("지금 실행", "Run now")}
                          </button>
                          <button
                            className="button"
                            type="button"
                            disabled={busy !== null}
                            onClick={() => void triggerAction(`trigger:${trigger.id}`, () => setScheduleEnabled(trigger.id, triggerPaused))}
                          >
                            {triggerPaused ? text("활성화", "Enable") : text("일시정지", "Pause")}
                          </button>
                        </>)}
                        <button
                          className="button"
                          type="button"
                          disabled={busy !== null}
                          onClick={() => openSettings(consumer.scheduleId)}
                        >
                          {text("편집", "Edit")}
                        </button>
                        {trigger && (
                          <button
                            className="button danger-subtle"
                            type="button"
                            disabled={busy !== null}
                            onClick={() => void removeTrigger(trigger)}
                          >
                            {text("삭제", "Delete")}
                          </button>
                        )}
                      </div>
                    </article>
                  );
                })}
                {roundlessWorkflows.map((workflow) => (
                  <article className="usage-budget-card muted" key={workflow.id} data-roundless-workflow={workflow.id}>
                    <div className="usage-budget-card-head">
                      <div>
                        <strong>{workflow.displayName ?? workflow.id}</strong>
                        <small>{text("페이싱 대상이지만 회차가 없어 돌지 않습니다.", "Paced, but without a round it never runs.")}</small>
                      </div>
                      <button
                        className="button"
                        type="button"
                        disabled={busy !== null}
                        onClick={() => setNewTriggerFor(workflow.id)}
                      >
                        {text("페이싱 추가", "Add pacing")}
                      </button>
                    </div>
                  </article>
                ))}
                {snapshot.consumers.filter((consumer) => consumer.scheduleExists).length === 0 && roundlessWorkflows.length === 0 && (
                  <p className="settings-empty">
                    {snapshot.pacingWorkflowIds.length === 0
                      ? text("페이싱 대상 워크플로가 없습니다. 회차를 맡길 워크플로를 먼저 등록하세요.", "No workflow is paced yet. Register the workflow you want to run in rounds first.")
                      : text("페이싱을 켠 워크플로를 돌리는 반복 요청이 없습니다.", "No scheduled request runs a pacing-enabled workflow.")}
                  </p>
                )}
              </div>
            </section>
          </div>
        )}
      </section>

      {defaultsOpen && snapshot && (
        <Modal
          title={text("예산 기본값", "Budget defaults")}
          onClose={() => setDefaultsOpen(false)}
          footer={<>
            <button className="button" type="button" onClick={() => setDefaultsOpen(false)} disabled={busy !== null}>{text("닫기", "Close")}</button>
            <button className="button primary" type="button" onClick={() => void saveDefaults()} disabled={busy !== null}>
              {busy === "defaults" ? <LoaderCircle size={14} className="spin" /> : text("저장", "Save")}
            </button>
          </>}
        >
          {/* 저장 실패는 모달 뒤 배너에만 떠 가려진다. 같은 오류를 모달 안에도 둔다. */}
          {error && <ErrorBanner message={error} />}
          {/* 계정 풀·회차 설정은 즉시 저장이고 여기는 초안이다. 같은 모양의 스위치가 두 규칙을 따르므로 어느 쪽인지 먼저 말해 준다. */}
          <p className="usage-budget-modal-note">
            {text(
              "이 모달의 값은 소진 모드 스위치까지 모두 저장을 눌러야 반영됩니다. 닫기로 나가면 고친 값은 버려집니다.",
              "Nothing here applies until you press save — the drain switch included. Closing discards your edits.",
            )}
          </p>
          <section className="usage-budget-modal-section">
            <header>
              <strong>{text("기본 목표·가드", "Default target and guard")}</strong>
              <small>
                {text(
                  `현재 창 ${snapshot.windowLabel}, 회차 간격 ${snapshot.cadenceMinutes}분. 비워 두면 캡 없이 워크플로 인자를 그대로 씁니다. 소진 모드가 몰아 쓰는 중인 계정은 이 두 값 대신 100%를 씁니다.`,
                  `Window ${snapshot.windowLabel}, cadence ${snapshot.cadenceMinutes} min. Leave empty to use workflow arguments without a cap. Accounts the drain mode is currently draining use 100% instead of these two.`,
                )}
              </small>
            </header>
            <div className="usage-budget-defaults">
              <label>
                <span>{text("목표 사용률(%)", "Target (%)")}</span>
                <input type="number" min={0} max={100} value={defaultsDraft?.targetPercent ?? ""} onChange={(event) => setDefaultsDraft({ ...defaultsDraft, targetPercent: parsePercent(event.target.value) })} />
              </label>
              <label>
                <span>{text("채울 창", "Window")}</span>
                <input type="text" value={defaultsDraft?.windowLabel ?? ""} placeholder="7일" onChange={(event) => setDefaultsDraft({ ...defaultsDraft, windowLabel: event.target.value })} />
              </label>
              <label>
                <span>{text("함께 지킬 창", "Guard window")}</span>
                <input type="text" value={defaultsDraft?.guardWindowLabel ?? ""} placeholder="5시간" onChange={(event) => setDefaultsDraft({ ...defaultsDraft, guardWindowLabel: event.target.value })} />
              </label>
              <label>
                <span>{text("가드 상한(%)", "Guard (%)")}</span>
                <input type="number" min={0} max={100} value={defaultsDraft?.guardPercent ?? ""} onChange={(event) => setDefaultsDraft({ ...defaultsDraft, guardPercent: parsePercent(event.target.value) })} />
              </label>
              <label>
                <span title={text("성향을 정하지 않은 회차가 물려받는 값입니다. 없으면 계정 여력만 보고 사다리의 기준칸(high)에서 오르내립니다.", "Rounds without their own profile inherit this. Without it the ladder moves around its anchor (high) on headroom alone.")}>
                  {text("기본 소비 성향", "Default spend profile")}
                </span>
                <select
                  value={defaultsDraft?.spendProfile ?? ""}
                  onChange={(event) => setDefaultsDraft({ ...defaultsDraft, spendProfile: (event.target.value || null) as SpendProfile | null })}
                >
                  <option value="">{text("없음 (자동·경계 없음)", "None (auto, no bounds)")}</option>
                  <option value="saver">{text("아껴쓰기", "Saver")}</option>
                  <option value="goal">{text("균형 (medium~high)", "Balanced (medium–high)")}</option>
                  <option value="quality">{text("품질 우선", "Quality first")}</option>
                </select>
              </label>
            </div>
          </section>
          <section className="usage-budget-modal-section">
            <header>
              <strong>{text("회당 소비 추이", "Cost per run trend")}</strong>
              <small>
                {text(
                  "소비자별로 처음 N회 관측의 중앙값을 기준선으로 한 번 붙박고, 회당 소비가 그 뒤로 어떻게 움직였는지 보여 줍니다. Claude는 실제 토큰, Codex는 창 %p로 잽니다. 추이만 보는 값입니다 — 등급은 회차 회전을 최대로 하도록 계획이 직접 고르므로 따로 목표를 정하지 않습니다.",
                  "The baseline is fixed once from the median of each consumer's first N runs and shows how per-run cost moved since. Claude uses real tokens, Codex uses window %. It is a trend readout only — the planner picks the effort that keeps the most rounds running, so there is no target to set.",
                )}
              </small>
            </header>
            <div className="usage-budget-defaults">
              <label>
                <span>{text("기준선 회차 수 (1~32)", "Baseline runs (1–32)")}</span>
                <input type="number" min={1} max={32} value={savingsDraft?.baselineRuns ?? ""} placeholder="5" onChange={(event) => setSavingsDraft({ targetReductionPercent: savingsDraft?.targetReductionPercent ?? null, baselineRuns: parseCount(event.target.value) })} onBlur={() => setSavingsDraft((current) => current?.baselineRuns == null ? current : { ...current, baselineRuns: clampBaselineRuns(current.baselineRuns) })} />
              </label>
            </div>
          </section>
          <section className="usage-budget-modal-section">
            <header>
              <strong>{text("소진 모드", "Drain mode")}</strong>
              <small>
                {text(
                  "쓸 수 있는 크레딧이 남은 계정은 채울 창과 짧은 창을 모두 100%까지, 시간에 직선으로 펴지 않고 몰아 써서 빨리 비우고, 비워진 창을 한도 리셋 크레딧으로 되돌린 뒤 다시 채웁니다. 공급자는 소진되지 않은 창에는 크레딧을 쓰지 못하게 물리므로, 목표 사용률에서 멈추면 크레딧을 쓸 길이 없어집니다 — 그래서 소진 중인 계정만 위의 목표·가드를 따르지 않습니다. 크레딧이 없거나 남겨 둘 장수만 남은 계정은 목표·가드와 균등 소비 그대로 둡니다 — 되돌릴 수단 없이 한도만 일찍 태우면 남은 기간 내내 그 계정이 멈춥니다. 페이싱 스케줄은 그대로 지키고, 추론수준도 바꾸지 않습니다.",
                  "Accounts with spendable credits fill both the target window and the short window to 100%, as fast as they can rather than spread evenly, then restore the emptied window with a rate limit reset credit and fill it again. The provider refuses to spend a credit on a window that is not used up, so stopping at the target leaves no way to use one — that is why draining accounts alone ignore the target and guard above. Accounts without spendable credits keep the target, the guard, and even pacing — draining with no way back strands them for the rest of the period. The pacing schedule still applies, and the effort level is left alone.",
                )}
              </small>
            </header>
            <div className="usage-budget-defaults">
              {/* 켜고 끄는 자리라 설정 화면 공용 스위치를 쓴다. 스위치는 버튼이라 label로
                  감싸지 않고, 옆 칸들과 같은 열 모양은 CSS가 맞춘다. */}
              <div className="usage-budget-drain-toggle">
                <span>{text("소진 모드", "Drain mode")}</span>
                <em>
                  <AppToggle
                    checked={defaultsDraft?.drain ?? false}
                    label={text("소진 모드", "Drain mode")}
                    onChange={(next) => setDefaultsDraft({ ...defaultsDraft, drain: next })}
                  />
                  {(defaultsDraft?.drain ?? false)
                    ? text("몰아 쓰고 되돌림", "Drain and restore")
                    : text("균등 소비", "Even pacing")}
                </em>
              </div>
              <label>
                <span title={text(
                  "소진 모드가 자동으로 쓰지 않고 남겨 둘 리셋 크레딧 장수입니다. 사람이 급할 때 직접 쓸 몫이며, 남은 장수가 여기에 닿은 계정은 소진 대상에서 빠집니다.",
                  "Reset credits the drain mode never spends on its own — your manual reserve. Accounts down to this count drop out of draining.",
                )}>
                  {text("남겨 둘 크레딧", "Credits to keep")}
                </span>
                <input
                  type="number"
                  min={0}
                  value={defaultsDraft?.drainReserveCredits ?? ""}
                  placeholder="0"
                  disabled={!(defaultsDraft?.drain ?? false)}
                  onChange={(event) => setDefaultsDraft({
                    ...defaultsDraft,
                    drainReserveCredits: event.target.value.trim() === "" ? null : Math.max(0, Number(event.target.value)),
                  })}
                />
              </label>
            </div>
          </section>
        </Modal>
      )}

      {scheduleOpen && snapshot && quietDraft && (
        <PacingScheduleModal
          snapshot={snapshot}
          draft={quietDraft}
          busy={busy}
          onChange={setQuietDraft}
          onSave={() => void saveQuiet()}
          onClose={() => setScheduleOpen(false)}
        />
      )}

      {poolOpen && snapshot && (
        <AccountPoolModal
          snapshot={snapshot}
          busy={busy}
          onSetTarget={setAccountTarget}
          onToggle={toggleAccount}
          onClose={() => setPoolOpen(false)}
        />
      )}

      {settingsConsumer && snapshot && (
        <Modal
          title={text(`회차 설정 · ${settingsConsumer.name ?? settingsConsumer.label ?? settingsConsumer.scheduleId}`, `Round settings · ${settingsConsumer.name ?? settingsConsumer.label ?? settingsConsumer.scheduleId}`)}
          onClose={closeSettings}
          size="wide"
        >
          <section className="usage-budget-modal-section">
            <header>
              <strong>{text("페이싱 설정", "Pacing settings")}</strong>
              <small>{text(
                "이 구역(참여·우선순위·상한·소비 성향·추론수준·참여 계정)은 저장 버튼이 없습니다 — 스위치와 셀렉트는 바꾸는 즉시, 숫자 칸은 칸을 벗어날 때 저장됩니다. 아래 '회차 트리거'만 저장을 눌러야 반영됩니다.",
                "This section (participation, priority, ceilings, spend profile, reasoning effort, accounts) has no save button — switches and selects save on change, number fields when you leave them. Only the round trigger below applies on save.",
              )}</small>
            </header>
            <div className="usage-budget-defaults">
              <label className="usage-budget-inline-field">
                <span>{text("우선순위 (0이 가장 높음)", "Priority (0 = highest)")}</span>
                <input
                  type="number"
                  min={0}
                  max={100}
                  defaultValue={settingsConsumer.priority}
                  disabled={busy !== null}
                  onBlur={(event) => setConsumerPriority(settingsConsumer, event.target.value)}
                />
              </label>
              <label className="usage-budget-inline-field">
                <span>{text("토큰 상한/회", "Max tokens/run")}</span>
                <input
                  type="number"
                  min={0}
                  step={1000}
                  defaultValue={settingsConsumer.maxTokensPerRun ?? ""}
                  placeholder={text("없음", "none")}
                  disabled={busy !== null}
                  onBlur={(event) => setConsumerCeiling(settingsConsumer, "maxTokensPerRun", event.target.value)}
                />
              </label>
              <label className="usage-budget-inline-field">
                <span>{text("%p 상한/회", "Max %p/run")}</span>
                <input
                  type="number"
                  min={0}
                  max={100}
                  step={0.5}
                  defaultValue={settingsConsumer.maxCostPercentPerRun ?? ""}
                  placeholder={text("없음", "none")}
                  disabled={busy !== null}
                  onBlur={(event) => setConsumerCeiling(settingsConsumer, "maxCostPercentPerRun", event.target.value)}
                />
              </label>
              <div className="usage-budget-toggle-field">
                <span title={text("상한을 넘으면 회차를 멈추는 대신 추론수준을 한 칸 낮춥니다. 더 낮출 데가 없을 때만 쉽니다.", "Over the ceiling the round lowers its effort one rung instead of stopping. It rests only when it cannot go lower.")}>{text("상한 초과 시", "Over ceiling")}</span>
                <AppToggle
                  checked={settingsConsumer.enforceCeiling}
                  disabled={busy !== null || (settingsConsumer.maxTokensPerRun === null && settingsConsumer.maxCostPercentPerRun === null)}
                  label={text("상한 초과 시 추론수준 낮춤(바닥이면 쉼)", "Lower the effort when over ceiling (rest if already at the floor)")}
                  onChange={(checked) => void toggleEnforce(settingsConsumer, checked)}
                />
              </div>
              <div className="usage-budget-toggle-field">
                <span>{text("참여", "Enabled")}</span>
                <AppToggle
                  checked={settingsConsumer.enabled ?? !snapshot.selectionConfigured}
                  disabled={busy !== null}
                  label={text(`${settingsConsumer.name ?? settingsConsumer.scheduleId} 페이싱 참여`, `Include ${settingsConsumer.name ?? settingsConsumer.scheduleId} in pacing`)}
                  onChange={(checked) => void toggleConsumer(settingsConsumer, checked)}
                />
              </div>
            </div>
            <div className="usage-budget-workflow-accounts">
              <header>
                <strong>{text("소비 성향", "Spend profile")}</strong>
                <small>
                  {text(
                    "회차가 얼마나 힘을 들일지 한 줄로 정합니다. 성향은 천장과 바닥만 잡고, 그 사이에서는 회차 회전을 최대로 하는 등급을 계획이 고릅니다 — 리셋 때 사라질 여유가 남을 때만 깊게 돕니다. 고르는 즉시 저장됩니다.",
                    "One line decides how hard a round works. The profile only sets the cap and floor; between them the planner maximizes how many rounds run, going deeper only for headroom that would expire at reset. Saves as soon as you pick.",
                  )}
                </small>
              </header>
              <label className="usage-budget-inline-field">
                <span>{text("성향", "Profile")}</span>
                <select
                  value={laneEditorOpen ? "custom" : settingsConsumer.spendProfile ?? "inherit"}
                  disabled={busy !== null}
                  onChange={(event) => setSpendProfile(settingsConsumer, event.target.value)}
                >
                  <option value="inherit">{text(`기본값 따름${defaultProfileLabel ? ` (${defaultProfileLabel})` : ""}`, `Follow default${defaultProfileLabel ? ` (${defaultProfileLabel})` : ""}`)}</option>
                  <option value="saver">{text("아껴쓰기 · 항상 최저", "Saver · always lowest")}</option>
                  <option value="goal">{text("균형 · medium~high", "Balanced · medium–high")}</option>
                  <option value="quality">{text("품질 우선 · 여력 있으면 높게", "Quality first · high when there is headroom")}</option>
                  <option value="custom">{text("직접 설정…", "Custom…")}</option>
                </select>
              </label>
              <small className="usage-budget-lane-hint">{spendProfileHint}</small>
              {laneEditorOpen && (<>
              <header>
                <strong title={text("자동 단계: 여력 0.5건/회차 미만 두 단계↓ · 1건 미만 한 단계↓ · 2건 이상 한 단계↑ · 4건 이상 두 단계↑", "Auto steps: under 0.5 runs/round two down · under 1 one down · 2+ one up · 4+ two up")}>
                  {text("추론수준 (공급자별)", "Reasoning effort (per provider)")}
                </strong>
                <small>
                  {text(
                    "자동은 계정 여력(리셋까지 남은 회차당 감당 건수)에 따라 high를 기준으로 오르내리고, 천장 위·바닥 아래로는 가지 않습니다. 고정은 여력과 무관하게 그 값으로 띄웁니다.",
                    "Auto moves up or down from high by account headroom and stays between the floor and the cap. Fixed ignores headroom.",
                  )}
                </small>
              </header>
              <ul className="usage-budget-lane-efforts">
                {effortLanes.map((provider) => {
                  const lane = settingsConsumer.reasoningEfforts?.[provider] ?? {};
                  const ladder = effortLadder(provider);
                  const bounds = [
                    lane.minAuto ? text(`최소 ${reasoningLabel(lane.minAuto)}`, `min ${lane.minAuto}`) : null,
                    lane.maxAuto ? text(`최대 ${reasoningLabel(lane.maxAuto)}`, `max ${lane.maxAuto}`) : null,
                  ].filter(Boolean).join(" · ");
                  const state = lane.fixed
                    ? text(`${reasoningLabel(lane.fixed)} 고정`, `fixed · ${lane.fixed}`)
                    : bounds
                      ? text(`자동 · ${bounds}`, `auto · ${bounds}`)
                      : text("자동", "auto");
                  return (
                    <li key={provider}>
                      <div className="usage-budget-lane-head">
                        <SourceBadge source={provider} />
                        <small>{state}</small>
                      </div>
                      <div className="usage-budget-lane-fields">
                        <label className="usage-budget-inline-field">
                          <span>{text("방식", "Mode")}</span>
                          <select
                            value={lane.fixed ?? "auto"}
                            disabled={busy !== null}
                            onChange={(event) => setLaneReasoningEffort(settingsConsumer, provider, { fixed: event.target.value === "auto" ? null : event.target.value })}
                          >
                            <option value="auto">{text("자동 (계정 여력)", "Auto (account headroom)")}</option>
                            {ladder.map((effort) => (
                              <option key={effort} value={effort}>{text(`고정 · ${reasoningLabel(effort)}`, `Fixed · ${effort}`)}</option>
                            ))}
                          </select>
                        </label>
                        <label className="usage-budget-inline-field">
                          <span>{text("자동 상한", "Auto cap")}</span>
                          <select
                            value={lane.fixed ? "" : lane.maxAuto ?? ""}
                            disabled={busy !== null || Boolean(lane.fixed)}
                            onChange={(event) => setLaneReasoningEffort(settingsConsumer, provider, { maxAuto: event.target.value || null })}
                          >
                            <option value="">{text("없음", "None")}</option>
                            {ladder.map((effort) => (
                              <option key={effort} value={effort}>{reasoningLabel(effort)}</option>
                            ))}
                          </select>
                        </label>
                        <label className="usage-budget-inline-field">
                          <span title={text("절감 목표와 상한 초과가 등급을 내릴 때 여기서 멈춥니다.", "The savings goal and ceiling stop lowering the effort here.")}>{text("자동 바닥", "Auto floor")}</span>
                          <select
                            value={lane.fixed ? "" : lane.minAuto ?? ""}
                            disabled={busy !== null || Boolean(lane.fixed)}
                            onChange={(event) => setLaneReasoningEffort(settingsConsumer, provider, { minAuto: event.target.value || null })}
                          >
                            <option value="">{text("없음", "None")}</option>
                            {ladder.map((effort) => (
                              <option key={effort} value={effort}>{reasoningLabel(effort)}</option>
                            ))}
                          </select>
                        </label>
                      </div>
                    </li>
                  );
                })}
              </ul>
              </>)}
            </div>
            {settingsConsumer.workflowId && selectableAccounts.length > 0 && (
              <div className="usage-budget-workflow-accounts">
                <header>
                  <strong>{text("참여 계정", "Accounts")}</strong>
                  <small>
                    {workflowAccountsUnrestricted
                      ? text("제한이 없어 풀에 켜진 계정을 모두 씁니다. 하나라도 끄면 남은 계정만 이 회차에 쓰이고, 끄는 즉시 저장됩니다.", "Unrestricted — every enabled account in the pool is used. Turn one off and only the rest run this round; it saves immediately.")
                      : text(`${workflowAccountIds.length}개 계정만 이 회차에 쓰입니다. 마지막 한 계정은 끌 수 없고, 바꾸는 즉시 저장됩니다.`, `Only ${workflowAccountIds.length} account(s) run this round. The last one cannot be turned off, and changes save immediately.`)}
                  </small>
                </header>
                <ul className="usage-budget-account-switches">
                  {selectableAccounts.map((account) => {
                    const selected = workflowAccountIds.includes(account.accountId);
                    // 전부 빼면 저장소의 빈 집합이 "제한 없음"으로 읽혀 의도와 반대가 된다.
                    // 마지막 한 계정은 누르지 못하게 스위치를 잠가, 눌러도 아무 일이 없는
                    // 대신 왜 못 끄는지가 모양으로 보이게 한다.
                    const locked = selected && workflowAccountIds.length <= 1;
                    const label = accountLabel(account);
                    return (
                      <li className={selected ? "" : "off"} key={account.accountId}>
                        <span>
                          <SourceBadge source={account.provider} />
                          <em>{label}</em>
                        </span>
                        <AppToggle
                          checked={selected}
                          disabled={busy !== null || locked}
                          label={text(`${label} 이 회차 참여`, `Include ${label} in this round`)}
                          onChange={(checked) => {
                            const next = checked
                              ? selectableAccountIds.filter((id) => id === account.accountId || workflowAccountIds.includes(id))
                              : workflowAccountIds.filter((id) => id !== account.accountId);
                            setWorkflowAccounts(settingsConsumer, next.length === selectableAccountIds.length ? [] : next);
                          }}
                        />
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
          </section>
          {schedules.get(settingsConsumer.scheduleId)
            ? (
              <section className="usage-budget-modal-section">
                <header>
                  <strong>{text("회차 트리거", "Round trigger")}</strong>
                  <small>{text("이름·주기·워크플로 인자는 저장을 눌러야 반영됩니다.", "Name, cadence, and workflow arguments apply only when you press save.")}</small>
                </header>
                <PacedTriggerEditor
                  embedded
                  workflows={workflows}
                  schedule={schedules.get(settingsConsumer.scheduleId)!}
                  guardWindowLabel={snapshot.defaults.guardWindowLabel ?? null}
                  quietHours={snapshot.defaults.quietHours ?? null}
                  onSaved={() => { closeSettings(); void load(); }}
                  onCancel={closeSettings}
                />
              </section>
            )
            : (
              <p className="usage-budget-modal-note">
                {text("이 소비자의 반복 요청이 없어 트리거를 고칠 수 없습니다. 설정만 남아 있습니다.", "This consumer has no scheduled request, so there is no trigger to edit — only its settings remain.")}
              </p>
            )}
        </Modal>
      )}

      {newTriggerFor !== null && snapshot && (
        <Modal title={text("새 페이싱 회차", "New paced round")} onClose={() => setNewTriggerFor(null)} size="wide">
          <PacedTriggerEditor
            embedded
            workflows={roundlessWorkflows}
            initialWorkflowId={newTriggerFor}
            guardWindowLabel={snapshot.defaults.guardWindowLabel ?? null}
            quietHours={snapshot.defaults.quietHours ?? null}
            onSaved={() => { setNewTriggerFor(null); void load(); }}
            onCancel={() => setNewTriggerFor(null)}
          />
        </Modal>
      )}
      {confirmDialog}
    </>
  );
}

/** 요약 줄: 채울 창과 목표, 함께 지킬 가드, 회차 간격을 한 줄로 붙인다. */
function budgetSummary(snapshot: UsageBudgetSnapshot, text: (ko: string, en: string) => string): string {
  const defaults = snapshot.defaults;
  const target = defaults.targetPercent === null || defaults.targetPercent === undefined
    ? text("목표 없음", "no target")
    : `${defaults.windowLabel?.trim() || snapshot.windowLabel} ${defaults.targetPercent}%`;
  const guard = defaults.guardPercent === null || defaults.guardPercent === undefined
    ? text("가드 없음", "no guard")
    : `${defaults.guardWindowLabel?.trim() || text("가드", "guard")} ${defaults.guardPercent}%`;
  const quiet = describeQuietHours(defaults.quietHours, text);
  return `${target} · ${guard} · ${cadenceLabel(snapshot.cadenceMinutes, text)}${quiet ? ` · ${quiet}` : ""}`;
}
