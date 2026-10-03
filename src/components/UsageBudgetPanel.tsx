import { AlertTriangle, CalendarClock, ChartPie, ChevronDown, ChevronRight, Gauge, LoaderCircle, PauseCircle, RefreshCw, Settings } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Dispatch, ReactNode, SetStateAction } from "react";
import { usageLevel } from "../lib/accountUsage";
import { reasoningLabel } from "../lib/chatSettings";
import { formatCountdown, formatDate, formatRelative, sourceName, formatDateOnly, formatDateTime } from "../lib/format";
import { useI18n, type UiText } from "../lib/i18n";
import { acknowledgeDrainNotice, deleteScheduledRequest, getSchedulerSnapshot, getSystemWorkflows, getUsageBudget, runScheduledRequestNow, setScheduleEnabled, setSystemWorkflowPacing, setUsageBudgetAccount, setUsageBudgetConsumer, setUsageBudgetPolicy, setUsageBudgetSavings, showNativeNotification } from "../lib/ipc";
// 참여 계정을 고르는 규칙의 정본. 요약 수치(`poolSummary`)가 아니라 계정 목록 자체가
// 필요한 자리들이 있어 pacingSummary를 거치지 않고 여기서 직접 가져온다 — 화면이 같은
// 필터를 다시 적으면 카드·모달·회차 설정이 서로 다른 "참여 계정"을 말하게 된다.
import { pooledAccounts } from "../lib/pacingAccounts";
import { accountLabel, consumerSummary, defaultQuietHours, describeQuietHours, poolSummary, quietWeekdays, WEEKDAY_NAMES, WEEKDAY_NAMES_EN, WEEKDAY_ORDER } from "../lib/pacingSummary";
import { PACING_PROVIDER_IDS } from "../lib/pacingSummary";
import type { PoolSummary } from "../lib/pacingSummary";
import { isWaitingRunStatus } from "../lib/schedulerSnapshot";
import { describeScheduleWorkflow } from "../lib/scheduleWorkflow";
import type { KnownReasoningEffort, LaneReasoningEffort, ProviderId, ReasoningEffort, QuietHours, SavingsDefaults, ScheduleRun, ScheduledRequest, SetUsageBudgetAccountRequest, SetUsageBudgetConsumerRequest, SystemWorkflowSummary, UsageBudgetAccount, UsageBudgetConsumer, UsageBudgetConsumerAccountCost,
  UsageBudgetConsumerEffortCost,
  SpendProfile, UsageBudgetDefaults, UsageBudgetSavingsReport, UsageBudgetSnapshot } from "../types";
import { PacedTriggerEditor } from "./PacedTriggerEditor";
import { AppToggle, ErrorBanner, HelpHint, Modal, SourceBadge, useConfirm } from "./Shared";
import { errorText } from "../lib/errorText";

import { runtimeCatalogText } from "../lib/i18nRuntime";
/** 회차 조작 한 번. 바쁨 표시 키와 실제 호출을 함께 받아 성공·실패를 훅이 처리한다. */
type TriggerAction = (key: string, action: () => Promise<unknown>) => Promise<void>;

/** 계정 한 줄이 내보내는 조작 두 가지. 풀 구역과 풀 모달이 같은 짝을 받는다. */
interface AccountActions {
  onSetTarget: (account: UsageBudgetAccount, raw: string) => void;
  onToggle: (account: UsageBudgetAccount, pacingEnabled: boolean) => void;
}

/** 소비자 한 벌의 소비 성향·레인 조작. 등급 구역과 설정 모달이 같은 짝을 받는다. */
interface ConsumerEffortActions {
  onSetSpendProfile: (consumer: UsageBudgetConsumer, value: string) => void;
  onSetLaneEffort: (consumer: UsageBudgetConsumer, provider: ProviderId, patch: LaneReasoningEffort) => void;
}

function percent(value: number | null | undefined, digits = 1): string {
  return value === null || value === undefined ? "–" : `${value.toFixed(digits)}%`;
}

function tokenCount(value: number): string {
  return Math.round(value).toLocaleString();
}

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

/**
 * 예산 모달의 구역 한 벌. 제목과 설명 한 줄을 이고 본문을 받는다. 네 모달의 여섯 구역이
 * 같은 `section > header > strong + small` 껍데기를 각자 적고 있어, 한 자리에서 `small`을
 * 빠뜨리거나 태그를 바꾸면 그 구역만 다른 모양이 되던 자리였다.
 */
function BudgetModalSection({ title, note, children }: {
  title: ReactNode;
  note: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="usage-budget-modal-section">
      <header>
        <strong>{title}</strong>
        <small>{note}</small>
      </header>
      {children}
    </section>
  );
}

/**
 * `div.usage-budget-defaults` 격자에 놓이는 칸 한 벌. 예산 기본값 모달의 일곱 칸과 스케줄
 * 모달의 시간대 칸이 `label > span + 본문` 껍데기를 각자 손으로 적고 있었고, 설명이 필요한
 * 칸만 `span`에 `title`을 걸었다 — 새 칸을 보태면서 `title`을 `label`에 걸거나 `span`을
 * 빼먹어도 격자 모양은 그대로라 읽어서는 갈라지지 않는 자리였다.
 *
 * 옆에 있는 `BudgetField`와 합치지는 않는다. 그쪽은 `usage-budget-inline-field` 클래스가
 * 붙어 격자 밖에서도 혼자 서는 칸이고, 여기에 그 클래스를 씌우면 격자 규칙(`.usage-budget-defaults
 * label`)과 겹쳐 칸 모양이 바뀐다 — 이 회차는 화면을 그대로 두는 것이 조건이다.
 */
function BudgetGridField({ label, title, className, children }: {
  label: ReactNode;
  title?: string;
  /** 격자에서 줄 전체를 쓰는 칸의 `wide` 같은 배치 클래스. 없으면 한 칸을 차지한다. */
  className?: string;
  children: ReactNode;
}) {
  return (
    <label className={className}>
      <span title={title}>{label}</span>
      {children}
    </label>
  );
}

/**
 * 격자 안의 입력 한 칸. 칸 이름과 그 설명(`title`)을 이고 입력 하나를 감싸는
 * `label.usage-budget-inline-field > span + 입력` 껍데기가 계정 풀·회차 설정·레인 표
 * 일곱 자리에 손복사돼 있었다 — `title`을 `label`에 걸거나 `span`을 빠뜨린 자리가 생기면
 * 그 칸만 설명이 뜨지 않는데, 읽어서는 갈라지지 않는다. 스위치 칸(`BudgetToggleField`)이
 * `div`로 같은 모양을 이미 한 벌 들고 있어 그 짝을 맞춘다.
 */
function BudgetField({ label, title, inline = false, children }: {
  label: ReactNode;
  title?: string;
  /** 이름을 입력 위가 아니라 왼쪽에 둔다. 칸이 하나뿐인 줄에서 세로를 아끼는 자리에 쓴다. */
  inline?: boolean;
  children: ReactNode;
}) {
  return (
    <label className={`usage-budget-inline-field${inline ? " inline" : ""}`}>
      <span title={title}>{label}</span>
      {children}
    </label>
  );
}

/**
 * 칸을 벗어날 때 저장하는 숫자 칸. 계정 목표 override와 회차 설정 세 칸(우선순위·토큰
 * 상한·%p 상한)은 "숫자 칸은 칸을 벗어날 때 저장한다"는 같은 규칙을 각자 적고 있었고,
 * 값은 저장본에서 시작하되 치는 동안 화면이 되감기지 않도록 비제어(`defaultValue`)로 두고
 * 초점을 잃을 때 친 원문을 그대로 넘기는 것까지 같았다. 다르던 것은 범위·단위·안내뿐이다.
 * 저장 시점을 한 자리에서만 고치면 나머지 세 칸이 조용히 뒤처지던 자리다.
 */
function BudgetCommitNumberField({ label, title, value, min, max, step, placeholder, inline, disabled, onCommit }: {
  label: ReactNode;
  title?: string;
  /** 저장본에서 온 시작값. 빈 칸은 `""`로 준다. */
  value: string | number;
  min?: number;
  max?: number;
  step?: number;
  placeholder?: string;
  /** `BudgetField`의 가로 배치. 격자 한 칸이 아니라 줄 하나를 쓰는 자리에서 켠다. */
  inline?: boolean;
  disabled: boolean;
  /** 칸을 벗어날 때 친 원문 그대로. 해석·유효성은 호출부가 맡는다. */
  onCommit: (raw: string) => void;
}) {
  return (
    <BudgetField label={label} title={title} inline={inline}>
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        defaultValue={value}
        placeholder={placeholder}
        disabled={disabled}
        onBlur={(event) => onCommit(event.target.value)}
      />
    </BudgetField>
  );
}

/**
 * 숫자 칸과 같은 규칙(비제어, 초점을 잃을 때 원문 그대로 저장)의 한 줄 글 칸. 완료조건처럼
 * 사람이 자유 문구로 적는 자리다. 숫자 칸을 `type`만 바꿔 쓰면 `min·max·step`이 뜻 없는
 * 칸에 남으므로 따로 둔다.
 */
function BudgetCommitTextField({ label, title, value, placeholder, maxLength, disabled, onCommit }: {
  label: ReactNode;
  title?: string;
  value: string;
  placeholder?: string;
  maxLength?: number;
  disabled: boolean;
  onCommit: (raw: string) => void;
}) {
  return (
    <BudgetField label={label} title={title}>
      <input
        type="text"
        defaultValue={value}
        placeholder={placeholder}
        maxLength={maxLength}
        disabled={disabled}
        onBlur={(event) => onCommit(event.target.value)}
      />
    </BudgetField>
  );
}

/**
 * 격자 안의 스위치 한 칸. 스위치는 버튼이라 `label`로 감싸지 못해 옆 칸들과 달리 `div`로
 * 적어야 하고, 그 모양이 계정 풀·스케줄·회차 설정 네 자리에 흩어져 있었다. `title`은 설명이
 * 필요한 칸만 준다.
 */
function BudgetToggleField({ label, title, checked, disabled, switchLabel, inline = false, onChange }: {
  label: string;
  title?: string;
  checked: boolean;
  disabled: boolean;
  /** 스위치 자체의 접근성 이름. 칸 이름보다 길게 적는 자리가 있어 따로 받는다. */
  switchLabel: string;
  /** 이름을 스위치 위가 아니라 왼쪽에 둔다. 다른 칸과 줄을 나눠 쓰는 자리에서 켠다. */
  inline?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className={`usage-budget-toggle-field${inline ? " inline" : ""}`}>
      <span title={title}>{label}</span>
      <AppToggle checked={checked} disabled={disabled} label={switchLabel} onChange={onChange} />
    </div>
  );
}

/**
 * 격자 한 줄을 통째로 쓰는 설명 줄. 스위치 이름만으로 무슨 일이 생기는지 모르는 칸의 설명을
 * 여기에 둔다 — `title`은 마우스를 올려야 나오니 설명을 거기에만 두면 없는 것과 같고, 스위치
 * 바로 아래 칸 폭(150px)에 넣으면 한 문장이 석 줄로 접혀 그 칸만 옆 칸보다 키가 커진다.
 */
function BudgetGridNote({ children }: { children: ReactNode }) {
  return <p className="usage-budget-defaults-note">{children}</p>;
}

/** 공급자별 비용 행을 묶는다. 순서를 주지 않으면 입력에서 처음 나타난 공급자 순서를 유지한다. */
function groupCostsByProvider<T extends { provider: ProviderId }>(costs: T[], providerOrder?: readonly ProviderId[]): { provider: ProviderId; costs: T[] }[] {
  const grouped = new Map<ProviderId, T[]>();
  for (const cost of costs) {
    const providerCosts = grouped.get(cost.provider) ?? [];
    providerCosts.push(cost);
    grouped.set(cost.provider, providerCosts);
  }
  return (providerOrder ?? [...grouped.keys()])
    .filter((provider) => grouped.has(provider))
    .map((provider) => ({ provider, costs: grouped.get(provider)! }));
}

/** 등급별 소비를 공급자별로 묶고, 사다리 순서(싼 것부터)로 세운다. */
function groupEffortCosts(costs: UsageBudgetConsumerEffortCost[]): { provider: ProviderId; costs: UsageBudgetConsumerEffortCost[] }[] {
  const order = ["low", "medium", "high", "xhigh", "max"];
  return groupCostsByProvider(costs, PACING_PROVIDER_IDS).map((group) => ({
    ...group,
    costs: [...group.costs].sort((a, b) => order.indexOf(a.reasoningEffort) - order.indexOf(b.reasoningEffort)),
  }));
}

/** 회당 소비 한 칸이 가진 수치. 추론수준별·계정별 관측이 공유하는 부분이다. */
interface AgentCostEntry {
  provider: ProviderId;
  tokensPerRun: number | null;
  percentPerRun: number | null;
  runs: number;
}

/**
 * 회당 소비 관측을 공급자별로 묶어 보여 주는 구역. 추론수준별과 계정별 두 벌이 머리줄 문구와
 * 항목 이름만 다를 뿐 골격(공급자 묶음 · 토큰/소비/실행 세 수치)이 같은 손복사본이었다. 한쪽에만
 * 수치를 더하거나 "–" 표기를 고치면 다른 쪽이 조용히 뒤처지므로 골격을 한 벌로 모으고, 다른
 * 부분만 인자로 받는다. 항목 이름은 `describe` 하나로 키·표시·툴팁을 함께 돌려준다 — 계정 이름은
 * 길어 잘리므로 툴팁이 필요하지만 등급 이름은 그렇지 않아, 두 갈래가 다르던 점을 그대로 지킨다.
 */
function AgentCostSection<T extends AgentCostEntry>({ title, unit, total, groups, describe }: {
  title: string;
  /** 개수 뒤에 붙는 단위. 한국어는 "3개 등급", 영어는 "3 levels"처럼 자리가 달라 따로 받는다. */
  unit: { noun: string; en: string };
  total: number;
  groups: { provider: ProviderId; costs: T[] }[];
  describe: (cost: T) => { key: string; label: string; title?: string };
}) {
  const { text } = useI18n();
  return (
    <section className="usage-budget-agent-costs" aria-label={title}>
      <header>
        <strong>{title}</strong>
        <small>{total}{text("개 ", " ")}{unit.noun}</small>
      </header>
      <div className="usage-budget-agent-cost-groups">
        {groups.map((group) => (
          <section className={`usage-budget-agent-cost-group source-${group.provider}`} key={group.provider}>
            <header>
              <SourceBadge source={group.provider} />
              <span>{group.costs.length}{text("개", ` ${unit.en}`)}</span>
            </header>
            <ul>
              {group.costs.map((cost) => {
                const item = describe(cost);
                return (
                  <li key={item.key}>
                    <em title={item.title}>{item.label}</em>
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
  );
}

/**
 * 숫자 칸 하나를 읽는다. 이 화면의 숫자 입력 다섯 자리가 "trim → 빈 값 처리 → `Number` →
 * `Number.isFinite` 확인"이라는 같은 네 줄을 각자 적고 있었고, 진짜로 다른 것은 빈 칸을
 * 무엇으로 볼지(캡 없음은 `null`, 상한 해제와 우선순위는 `0`) 하나뿐이었다. 그 하나만
 * 인자로 받고 나머지는 여기서 한 번만 적는다. 숫자가 아니면 언제나 `null`이라 호출부는
 * "고치지 않고 돌아간다"는 판단을 그대로 유지한다.
 */
function parseNumberField(raw: string, whenEmpty: number | null): number | null {
  const trimmed = raw.trim();
  if (trimmed === "") return whenEmpty;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

/** 백분율은 화면에서도 저장에서도 0~100 밖으로 나가지 않는다. 입력 보정과 막대 그리기가 같은 규칙을 봐야 한다. */
function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

/** 빈 입력은 "캡 없음"(null), 숫자는 0~100으로 잘라 보낸다. */
function parsePercent(raw: string): number | null {
  const value = parseNumberField(raw, null);
  return value === null ? null : clampPercent(value);
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

/**
 * 기준선 회차 수의 허용 범위. 백엔드가 1~32 밖을 거절하므로(usage_budget_policy.rs) 저장
 * 경로와 화면 보정이 같은 규칙을 봐야 한다 — 한쪽만 자르면 조용히 다른 값이 저장된다.
 */
function clampBaselineRuns(value: number): number {
  return Math.min(32, Math.max(1, Math.round(value)));
}

/** 빈 입력은 미입력(null). 범위는 저장할 때 자르므로 여기서는 자르지 않는다. */
function parseCount(raw: string): number | null {
  return parseNumberField(raw, null);
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
function quietStatusText(snapshot: UsageBudgetSnapshot, text: UiText): string {
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
  text: UiText,
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
  // 서빙 서버가 추론 수준을 어떻게 받을지 모델마다 달라 v1은 빈 사다리다.
  local: [],
};

/** 최근 회차 실효를 셀 표본 수. 자동 주기가 10~20분이면 서너 시간을 덮는다. */
const RECENT_ROUND_SAMPLE = 12;

/**
 * 최신순 실행 목록을 일정별 최근 실행과 제한된 표본으로 한 번에 색인한다. 호출부는 조회와
 * 상태 반영만 맡고, 첫 항목 유지와 표본 상한 규칙은 이 계산에 모아 둔다.
 */
function indexScheduleRuns(runs: ScheduleRun[]): {
  latest: Map<string, ScheduleRun>;
  recent: Map<string, ScheduleRun[]>;
} {
  const latest = new Map<string, ScheduleRun>();
  const recent = new Map<string, ScheduleRun[]>();
  for (const run of runs) {
    if (!latest.has(run.scheduleId)) latest.set(run.scheduleId, run);
    const bucket = recent.get(run.scheduleId) ?? [];
    if (bucket.length < RECENT_ROUND_SAMPLE) bucket.push(run);
    recent.set(run.scheduleId, bucket);
  }
  return { latest, recent };
}

/**
 * 반복 요청 쪽 색인 한 벌 — 회차 트리거, 트리거별 최근 실행 한 건, 최근 회차 표본. 셋은
 * 스케줄러 스냅샷 한 번에서 함께 나와 언제나 같은 자리로 함께 흘러가는데, 상태 선언부터
 * 카드까지 여섯 자리가 각자 세 칸으로 펼쳐 적고 세 줄로 넘기고 있었다. 한 벌로 묶어 두면
 * 색인을 하나 더할 때 넘기는 자리를 다시 훑지 않아도 되고, 세 칸 중 하나만 옛 값으로 넘기는
 * 어긋남이 애초에 생기지 않는다.
 */
type RoundIndex = {
  schedules: Map<string, ScheduledRequest>;
  lastRuns: Map<string, ScheduleRun>;
  recentRuns: Map<string, ScheduleRun[]>;
};

/** 아직 읽지 못했거나 읽기에 실패했을 때의 빈 색인. 호출부마다 `new Map()` 셋을 적지 않는다. */
function emptyRoundIndex(): RoundIndex {
  return { schedules: new Map(), lastRuns: new Map(), recentRuns: new Map() };
}

/**
 * 최근 회차 중 실제로 기동한 회차와 쉰 회차. 회차 봉투는 기동이 0건이어도 성공이라
 * 실행 목록이 전부 "완료"로 보인다 — 몇 시간째 아무것도 안 띄우고 있어도 그렇다.
 */
function recentRoundTally(runs: ScheduleRun[] | undefined): { worked: number; rested: number; launched: number } | null {
  let tally: { worked: number; rested: number; launched: number } | null = null;
  for (const run of runs ?? []) {
    if (!run.round) continue;
    tally ??= { worked: 0, rested: 0, launched: 0 };
    if (run.round.launchedRuns > 0) tally.worked += 1;
    else if (run.round.launchedRuns === 0) tally.rested += 1;
    tally.launched += run.round.launchedRuns;
  }
  return tally;
}

/** 소비자 행 요약에 붙일 레인별 추론수준 설정. 전부 자동·상한 없음이면 빈 문자열. */
function laneEffortSummary(consumer: UsageBudgetConsumer, text: UiText): string {
  const parts = PACING_PROVIDER_IDS.flatMap((provider) => {
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

function cadenceLabel(minutes: number | null, text: UiText): string {
  if (minutes === null) return text("간격 알 수 없음", "Unknown cadence");
  if (minutes % 60 === 0) return text(`${minutes / 60}시간마다`, `Every ${minutes / 60}h`);
  return text(`${minutes}분마다`, `Every ${minutes} min`);
}

/**
 * 회차가 실제로 무엇을 했는지. 회차 봉투는 기동이 0건이어도 성공으로 끝나므로 상태만으로는
 * 일한 회차와 쉰 회차가 같아 보인다. 목록에서 그 둘을 가르는 것이 이 줄이다.
 */
function roundOutcomeText(run: ScheduleRun | null, text: UiText): string | null {
  const round = run?.round;
  if (!round) return null;
  if (round.launchedRuns === 0) return text("쉼 · 기동 없음", "rested · nothing launched");
  const stale = round.staleRuns > 0 ? text(` · 정리 ${round.staleRuns}건`, ` · ${round.staleRuns} cleaned`) : "";
  return text(`기동 ${round.launchedRuns}건`, `${round.launchedRuns} launched`) + stale;
}

function runStatusText(status: ScheduleRun["status"], text: UiText): string {
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
 * 회차 카드 하나가 그리는 파생값 한 벌. 카드의 `map` 콜백이 상태 맵 세 개(트리거·최근 실행·
 * 최근 회차)를 뒤지고, 비용을 공급자별로 묶고, 접힌 상세를 한 줄로 요약하는 일까지 서른 줄 가까이
 * 계산한 뒤에야 첫 마크업이 나와, 카드가 무엇을 그리는지 보려면 그 계산을 모두 지나쳐야 했다.
 * 계산은 소비자·스냅샷·상태 맵만 보는 순수 함수라 렌더 밖으로 통째로 옮긴다 — 렌더에 남는 것은
 * 이 함수가 돌려준 이름들과 펼침 여부(컴포넌트 상태)뿐이다.
 *
 * 기본 정보 지표 줄 셋(반복주기·다음 실행·최근 실행)의 본값·보조줄은 그 뒤에도 카드 JSX 안에
 * 남아, 한 지표를 읽으려면 삼항 사다리와 조각 마크업을 함께 지나야 했다. 그중 최근 실행은
 * `roundOutcomeText`·`runStatusText`를 본값과 보조줄에서 각각 한 번씩 더 불러, 같은 판단이
 * 네 자리에 흩어진 채 두 번 계산되고 있었다. 그 여섯 값도 여기로 옮겨 계산은 한 번만 하고,
 * 카드에는 배치만 남긴다. 보조줄은 조각이 아니라 이어 붙인 문자열이라 그리는 글자는 같다.
 */
function consumerCardView({ consumer, snapshot, rounds, workflows, pacingOn, text }: {
  consumer: UsageBudgetConsumer;
  snapshot: UsageBudgetSnapshot;
  rounds: RoundIndex;
  workflows: SystemWorkflowSummary[];
  /** 페이싱 기능 전체 스위치. 꺼져 있으면 저장된 다음 실행 시각은 발화하지 않는 값이다. */
  pacingOn: boolean;
  text: UiText;
}) {
  const isActive = snapshot.activeConsumers.includes(consumer.scheduleId);
  const trigger = rounds.schedules.get(consumer.scheduleId) ?? null;
  const lastRun = rounds.lastRuns.get(consumer.scheduleId) ?? null;
  const tally = recentRoundTally(rounds.recentRuns.get(consumer.scheduleId));
  const runActive = Boolean(lastRun && (lastRun.status === "running" || isWaitingRunStatus(lastRun.status)));
  const runQueued = Boolean(trigger?.manualRunRequestedAt) && !runActive;
  // 일시정지 여부는 스냅샷과 트리거 어느 한쪽이라도 꺼져 있으면 꺼진 것으로 본다.
  // 두 값은 같은 반복 요청에서 나오지만 읽은 시점이 다를 수 있어, 한쪽만 보면
  // "비활성" 배지 옆에 다음 실행 시각이 남는다.
  const triggerPaused = consumer.scheduleEnabled === false || trigger?.enabled === false;
  // 완료조건을 채운 회차. 트리거가 켜져 있어도 예약 기동을 받지 않으므로 일시정지보다 먼저 본다 —
  // 배지·다음 실행·실행 버튼이 모두 이 한 값에서 갈린다.
  const completed = consumer.completedAt != null;
  const sprint = consumer.sprint === true;
  const summary = consumerSummary(consumer, snapshot.accounts);
  const accountCostGroups = groupCostsByProvider<UsageBudgetConsumerAccountCost>(consumer.costs?.perAccount ?? []);
  const accountCostCount = accountCostGroups.reduce((count, group) => count + group.costs.length, 0);
  const effortCosts = consumer.costs?.perEffort ?? [];
  // 처리량은 같은 계정 범위를 공유하는 회차 그룹별 판정이다. 현재 카드의
  // 권장값만 골라 보여 무관한 워크플로를 조정 대안으로 섞지 않는다.
  const throughput = consumer.throughput ?? null;
  const maxRuns = trigger?.workflow?.pacing?.maxRuns ?? 1;
  // 최근 실행의 결과 한 줄. 회차 봉투를 두른 실행이면 기동 건수가, 아니면 상태가 본값이 되고
  // 남는 쪽이 보조줄 앞에 붙는다. 본값과 보조줄이 각자 같은 두 함수를 부르던 자리다.
  const outcome = roundOutcomeText(lastRun, text);
  const status = lastRun ? runStatusText(lastRun.status, text) : null;
  return {
    isActive,
    trigger,
    lastRun,
    tally,
    runActive,
    runQueued,
    triggerPaused,
    completed,
    sprint,
    summary,
    label: consumer.name ?? consumer.label ?? consumer.scheduleId,
    /**
     * 계약 안에서 스스로 페이싱하던 구형 워크플로인가. 제목 줄의 배지 하나를 위해 마크업이
     * 워크플로 목록을 다시 훑고 있어, 배지를 읽으려면 `ConsumerRoundHead`가 왜 목록 전체를
     * 받는지부터 거슬러 올라가야 했다. 판정은 소비자와 목록만 보므로 다른 파생값과 같은
     * 자리에서 한 번만 한다 — 제목 줄은 이제 목록을 받지 않는다.
     */
    legacyContractPacing: workflows.find((workflow) => workflow.id === consumer.workflowId)?.pacingMode === "contract",
    /**
     * 실행 버튼에 적을 말. 세 갈래(도는 중·요청 접수됨·대기)가 버튼 마크업 안에서 갈라지며
     * `lastRun!`으로 비단언을 하나 세우고 있었다 — 바로 위에서 이미 낸 `status`와 같은
     * 판정을 두 번째로 하는 자리라, 한쪽 조건만 고치면 버튼 글자와 카드의 최근 실행 줄이
     * 서로 다른 상태를 말하게 된다. `runActive`가 참이면 `lastRun`도 있으므로 `status`
     * 폴백은 그리는 글자를 바꾸지 않는다.
     */
    runButtonLabel: runActive && status
      ? status
      : runQueued ? text("실행 요청됨", "Run requested") : text("지금 실행", "Run now"),
    accountCostGroups,
    accountCostCount,
    effortCosts,
    effortGroups: groupEffortCosts(effortCosts),
    throughput,
    ownThroughput: throughput?.rounds.find((round) => round.scheduleId === consumer.scheduleId) ?? null,
    cadenceValue: cadenceLabel(consumer.cadenceMinutes, text),
    cadenceNote: (trigger?.recurrence.frequency === "auto" ? text("자동 계산", "auto") : text("고정 주기", "fixed"))
      + (maxRuns > 1 ? text(` · 병렬 ${maxRuns}건`, ` · ${maxRuns} parallel`) : "")
      + (sprint ? text(" · 스프린트", " · sprint") : ""),
    // 페이싱이 꺼져 있으면 저장된 다음 실행 시각을 그대로 두면 안 된다 — 지난 시각이
    // "다음 실행"으로 남아 회차가 밀린 것처럼 보인다. 완료된 회차도 같다.
    nextRunValue: !trigger
      ? "–"
      : completed ? text("완료", "completed")
        : triggerPaused ? text("일시정지", "paused") : !pacingOn ? text("페이싱 꺼짐", "pacing off") : formatRelative(trigger.nextRunAt),
    // 페이싱이 꺼져 있으면 제한 시간대가 열려도 발화하지 않는다. 본값이 "페이싱 꺼짐"인데
    // 보조줄이 "제한 시간대 대기"를 말하면 시간대만 지나면 다시 도는 줄로 읽힌다.
    nextRunNote: (pacingOn && snapshot.quietStatus?.blocked && trigger && !triggerPaused && !completed
      ? `${text("제한 시간대 대기", "waiting for quiet hours")} · `
      : "")
      + (trigger?.workflow ? describeScheduleWorkflow(trigger.workflow, workflows) : "–"),
    lastRunValue: lastRun ? (outcome ?? status ?? "–") : "–",
    lastRunNote: (outcome && status ? `${status} · ` : "")
      + text(`기록 ${consumer.costs?.recordedRuns ?? 0}건`, `${consumer.costs?.recordedRuns ?? 0} recorded`),
    // 접혀 있을 때도 무엇이 접혀 있는지는 알려야 한다 — 접힌 칸의 값 몇 개를
    // 토글 줄에 요약해, 펴 볼 이유가 없으면 펴지 않아도 되게 한다.
    detailSummary: [
      text(`평균 소진율 ${percent(summary.averageUsedPercent, 0)}`, `avg used ${percent(summary.averageUsedPercent, 0)}`),
      summary.remainingRuns === null
        ? text("남은 예산 미측정", "budget not measured")
        : text(`남은 예산 약 ${summary.remainingRuns}회`, `≈ ${summary.remainingRuns} runs left`),
      accountCostCount > 1 ? text(`계정별 소비 ${accountCostCount}개`, `${accountCostCount} account costs`) : null,
      tally ? text(`최근 ${tally.worked + tally.rested}회차 중 일함 ${tally.worked}`, `${tally.worked}/${tally.worked + tally.rested} rounds worked`) : null,
    ].filter(Boolean).join(" · "),
  };
}

type ConsumerCardView = ReturnType<typeof consumerCardView>;

/**
 * 회차 카드의 상세정보를 처음부터 접어 둘 기준 폭(px). 뷰포트가 아니라 패널 자신의 폭을
 * 잰다 — 패널은 이미 컨테이너(`container-type: inline-size`)이고 좁은 화면 규칙도 그 폭을
 * 기준으로 걸려 있어, 창은 넓지만 패널이 좁은 경우(사이드바가 열린 데스크톱)에도 카드가
 * 세로로 길어지는 것은 똑같기 때문이다. 값은 패널의 좁은 화면 컨테이너 쿼리와 맞춘다.
 */
const NARROW_PANEL_WIDTH = 760;

/**
 * 회차 카드의 상세정보를 펼칠지 접을지. "패널이 좁은가"(관찰)와 "사용자가 뒤집었는가"(기억)가
 * 함께 정하는 한 가지 답이라 두 상태와 관찰자가 늘 같이 움직이는데, 스냅샷·초안·모달을 드는
 * 패널 상태 한가운데에 25줄로 끼어 있어 기준 폭 상수는 여기, 그 상수를 읽는 관찰자는 1200줄
 * 아래에 떨어져 있었다. 기준 폭 바로 옆으로 모아 셋을 한눈에 대조한다.
 *
 * 패널 상태를 하나도 읽지 않고 돌려주는 값도 그대로라, 옮기기 전과 같은 답을 낸다.
 */
function useRoundDetailDisclosure() {
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

  return { panelRef, detailOpen, toggleDetail };
}

/**
 * 이 계정 창이 초기화되는 시각. 0은 "창을 모른다"는 뜻이라 시각으로 읽지 않는다.
 *
 * 막대의 카운트다운(QA #75)과 같은 쿼터 풀 묶기(QA #94)가 이 규칙을 같이 봐야 하는데,
 * 두 자리가 `resetsAt <= 0`을 각자 적고 그 이유도 각자 주석으로 달고 있었다 — 한쪽만
 * 고치면 0이 한 자리에서만 시각이 되어, 초기화 시각을 모르는 계정끼리 같은 풀로 묶이거나
 * 지나간 카운트다운이 다시 뜬다.
 */
function accountResetsAt(account: UsageBudgetAccount): number | null {
  const resetsAt = account.overview?.resetsAt ?? null;
  return resetsAt === null || resetsAt <= 0 ? null : resetsAt;
}

/**
 * 등록된 계정이 하나도 없을 때의 한 줄. 같은 풀을 읽기로 보여 주는 카드와 고치는 모달이
 * 같은 빈 상태를 각자 적고 있었다 — 문구가 갈라지면 같은 화면에서 두 말을 하게 된다.
 */
function AccountPoolEmpty() {
  const { text } = useI18n();
  return <p className="settings-empty">{text("등록된 공급자 계정이 없습니다.", "No provider accounts are registered.")}</p>;
}

/**
 * 계정 풀 카드의 소진 막대 한 줄. 한 계정에서 나오는 파생값(사용률·목표·초기화까지 남은
 * 시간)과 그 값을 쓰는 네 자리(클래스·툴팁·수치·막대 aria)가 카드 JSX 세 겹 안에 그대로
 * 들어 있어, 계정 한 줄이 무엇을 보여 주는지 읽으려면 카드 전체를 따라가야 했다. 파생과
 * 표시를 이 한 줄짜리 컴포넌트로 가르고, 카드는 계정 목록을 돌리는 일만 한다.
 *
 * `now`는 호출부가 넘긴다 — 카드가 한 번 읽은 시각을 모든 줄이 같이 써야 줄마다 남은 시간이
 * 어긋나지 않는다.
 */
function AccountPoolBar({ account, windowLabel, now }: {
  account: UsageBudgetAccount;
  windowLabel: string;
  now: number;
}) {
  const { text } = useI18n();
  const raw = account.overview?.usedPercent;
  const used = raw === null || raw === undefined ? null : clampPercent(raw);
  const usedText = used === null ? null : `${Math.round(used)}%`;
  const target = account.overview?.targetPercent ?? null;
  const label = accountLabel(account);
  /**
   * 이 계정 창이 초기화될 때까지 남은 시간("1d 12h", "5h 12m"). 창은 계정마다 다른 시각에
   * 열려 카드의 "가장 이른 초기화" 한 칸으로는 지금 어느 계정이 곧 비는지 알 수 없다.
   * 시각이 이미 지났거나 없으면 적지 않는다.
   */
  const resetsAt = accountResetsAt(account);
  const resetIn = resetsAt === null ? null : formatCountdown(resetsAt - now);
  const statusText = !account.pacingEnabled
    ? text("제외됨", "excluded")
    : account.disabled
      ? text("비활성 · 회차가 쓰지 못함", "disabled · not usable by rounds")
      : text("참여 중", "included");
  const targetText = target === null ? "" : ` · ${text("목표", "target")} ${Math.round(target)}%`;
  const resetText = resetsAt === null || resetIn === null ? "" : ` · ${resetIn} ${text("후 초기화", "resets in")} (${formatDate(resetsAt)})`;
  const fallbackUsed = text("확인 불가", "unavailable");
  const displayUsed = usedText ?? fallbackUsed;
  return (
    <li
      // 회차가 쓰지 못하는 비활성 계정은 막대에서도 참여 계정과 갈라 보인다. 하단
      // 안내문의 "비활성 N개"만으로는 목록이 길 때 어느 계정인지 찾을 수 없다(QA #57).
      className={`${used === null ? "unmeasured" : usageLevel(used)}${account.pacingEnabled ? "" : " off"}${account.disabled ? " disabled" : ""}`}
      title={`${label} · ${statusText}${targetText}${resetText}`}
    >
      <span>
        <SourceBadge source={account.provider} />
        <em>{label}</em>
        <b>{displayUsed}</b>
        {resetsAt !== null && resetIn !== null && (
          <time
            dateTime={new Date(resetsAt).toISOString()}
            aria-label={text(`${label} 창 초기화까지 ${resetIn}`, `${label} window resets in ${resetIn}`)}
          >
            {resetIn}
          </time>
        )}
      </span>
      <div
        className="progress"
        role="img"
        aria-label={`${label} ${runtimeCatalogText(windowLabel)} ${text("사용량", "usage")} ${displayUsed}`}
      >
        <span style={{ width: `${used ?? 0}%` }} />
        {/* 목표선. 막대가 어디까지 차야 이 계정의 몫을 다 쓴 것인지 눈금으로 알린다. */}
        {target !== null && target > 0 && target < 100 && <i style={{ left: `${target}%` }} />}
      </div>
    </li>
  );
}

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
  // 남은 시간은 30초마다 다시 읽는 스냅샷과 함께 다시 그려진다 — 표기가 분 단위라 그 사이
  // 값이 어긋나 보이지 않으므로 별도 타이머를 세우지 않는다.
  const now = Date.now();
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
          ? <AccountPoolEmpty />
          : (
            <article className={`usage-budget-card usage-budget-pool-card${pool.pooled === 0 ? " muted" : ""}`}>
              <div className="usage-budget-card-head">
                <div>
                  <strong>{text(`페이싱 계정 ${pool.pooled} / ${pool.total}`, `Pacing accounts ${pool.pooled} / ${pool.total}`)}</strong>
                  <small>
                    {pool.pooled === 0
                      ? text("아직 참여 계정을 고르지 않았습니다.", "No account has been added to the pool yet.")
                      : text(`${snapshot.windowLabel} 창 기준 현황입니다.`, `Current state of the ${runtimeCatalogText(snapshot.windowLabel)} window.`)}
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
                <Metric label={text("평균 소진율", "Average used")} value={percent(pool.averageUsedPercent, 0)} note={runtimeCatalogText(snapshot.windowLabel)} />
                <Metric label={text("평균 순여유", "Average headroom")} value={percent(pool.averageHeadroomPercent, 0)} note={text("목표까지", "to target")} />
                <Metric
                  label={text("최다 소진 계정", "Busiest account")}
                  value={pool.busiest ? percent(pool.busiest.usedPercent, 0) : "–"}
                  note={pool.busiest?.label ?? "–"}
                />
                <Metric label={text("가장 이른 초기화", "Earliest reset")} value={formatRelative(pool.earliestResetAt)} note={text("창 리셋", "window reset")} />
              </dl>
              <ul className="usage-budget-pool-bars">
                {snapshot.accounts.map((account) => (
                  <AccountPoolBar key={account.accountId} account={account} windowLabel={snapshot.windowLabel} now={now} />
                ))}
              </ul>
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
 * 소진 현황 한 줄("<창> <사용률> 사용 · <상한 이름> <값> · 미정산 예약 <값> · 순여유 <값>").
 * 계정 풀 모달이 창 전체와 가드마다 이 문장을 한국어·영어로 따로 적어 세 벌이 흩어져 있었고,
 * 칸 하나를 더하거나 구분자를 바꾸면 여섯 문자열을 같이 고쳐야 했다. 모양은 여기 한 벌만 둔다.
 *
 * 보이고 말고는 호출부가 정한다 — `cap`이 null이면 상한 칸을, `netHeadroomPercent`가 null이면
 * 순여유 칸을 적지 않는다. 가드는 순여유를 못 재면 상한도 함께 감추던 지금 동작을 그대로
 * 두려고 두 값을 같은 조건에서 넘긴다.
 */
function usageOverviewLine(
  { headLabel, usedPercent, cap, outstandingClaimPercent, netHeadroomPercent }: {
    headLabel: string;
    usedPercent: number | null;
    cap: { label: string; value: number | null } | null;
    outstandingClaimPercent: number;
    netHeadroomPercent: number | null;
  },
  text: UiText,
): string {
  const parts = [text(`${headLabel} ${percent(usedPercent, 0)} 사용`, `${headLabel} used ${percent(usedPercent, 0)}`)];
  if (cap) parts.push(`${cap.label} ${percent(cap.value, 0)}`);
  parts.push(text(`미정산 예약 ${percent(outstandingClaimPercent)}`, `outstanding claims ${percent(outstandingClaimPercent)}`));
  if (netHeadroomPercent !== null) parts.push(text(`순여유 ${percent(netHeadroomPercent)}`, `net headroom ${percent(netHeadroomPercent)}`));
  return parts.join(" · ");
}

/**
 * 같은 쿼터 풀을 쓰는 다른 계정들의 이름.
 *
 * 구독을 가족과 공유하면 구성원들이 창 하나를 함께 쓴다 — 주간 창의 초기화 시각이 밀리초까지
 * 같게 온다(2026-09-18 실측: 가족 두 계정은 같은 시각, 가족에서 뺀 두 계정은 각자 시각).
 * 그런 계정을 둘 다 참여로 켜 두면 페이싱이 같은 쿼터를 두 축으로 세어, 한쪽이 풀을 다 써도
 * 다른 쪽에 여유가 있는 줄 알고 계속 배정한다. 막지는 않고 알리기만 한다 — 어느 쪽을 쓸지는
 * 사용자가 정할 일이고, 초기화 시각이 우연히 겹칠 가능성도 남겨 둔다.
 */
function quotaPoolMates(accounts: UsageBudgetAccount[], account: UsageBudgetAccount): string[] {
  // 초기화 시각을 모르는 계정(`accountResetsAt`가 null로 읽는 자리)은 아무와도 묶지 않는다.
  // 0을 일반 값으로 두면 시각을 모르는 계정끼리 '같은 쿼터 풀'로 묶여, 아무 관계 없는
  // 계정의 참여를 끄게 만든다(QA #94).
  const resetsAt = accountResetsAt(account);
  if (resetsAt === null) return [];
  return accounts
    .filter((other) => other.accountId !== account.accountId
      && other.provider === account.provider
      && accountResetsAt(other) === resetsAt)
    .map(accountLabel);
}

/**
 * 계정 풀 설정 모달의 개별 계정 행.
 * 제공자 뱃지와 이름, 창별 사용량/목표/가드 정보, 목표 override 입력칸, 페이싱 참여 토글을 그린다.
 *
 * 읽는 차례("누구" → "얼마나 썼나" → "어떻게 쓸까") 그대로 세 덩이만 낸다. 좁은 화면에서는
 * 세 줄로 쌓이고 넓은 화면에서는 조작 덩이가 오른쪽 열로 간다 — 모달은 백드롭에 그려져
 * 컨테이너 쿼리가 닿지 않으므로 이 갈림은 뷰포트 폭이 정한다. 예전에는 칸 이름을 입력 위에
 * 얹은 조작 두 칸을 격자로 세워, 폭이 줄면 이름·사용량·입력·스위치가 각자 한 줄씩 차지하며
 * 계정 하나가 화면 높이의 절반을 먹었다.
 */
function AccountPoolModalRow({
  account,
  poolMates,
  windowLabel,
  busy,
  onSetTarget,
  onToggle,
}: {
  account: UsageBudgetAccount;
  /** 같은 쿼터 풀을 쓰는 다른 계정 이름들. 비어 있으면 이 계정만의 창이다. */
  poolMates: string[];
  windowLabel: string;
  busy: boolean;
} & AccountActions) {
  const { text } = useI18n();
  const overview = account.overview;
  const label = accountLabel(account);

  return (
    <div className={`usage-budget-modal-row${account.pacingEnabled ? "" : " muted"}`} data-account-id={account.accountId}>
      <div className="usage-budget-modal-row-head">
        <SourceBadge source={account.provider} />
        <strong>{label}</strong>
      </div>
      <small className="usage-budget-modal-row-usage">
        {overview?.usedPercent !== null && overview?.usedPercent !== undefined
          ? usageOverviewLine({
            headLabel: windowLabel,
            usedPercent: overview.usedPercent,
            cap: { label: text("목표", "target"), value: overview.targetPercent },
            outstandingClaimPercent: overview.outstandingClaimPercent,
            netHeadroomPercent: overview.netHeadroomPercent,
          }, text)
          : text("이 창의 사용량이 없습니다", "No usage for this window")}
        {account.disabled ? ` · ${text("비활성 계정", "disabled")}` : ""}
        {poolMates.length > 0 && (
          <span className="usage-budget-pool-warning">
            {" · "}
            {text(
              `${poolMates.join(", ")}와 같은 쿼터 풀`,
              `shares a quota pool with ${poolMates.join(", ")}`,
            )}
          </span>
        )}
        {(overview?.guards ?? []).map((guard) => (
          <span className="usage-budget-guard-overview" key={guard.label}>
            {" · "}
            {usageOverviewLine({
              headLabel: guard.label,
              usedPercent: guard.usedPercent,
              // 순여유를 못 재는 가드는 상한도 적지 않는다(지금 동작 그대로).
              cap: guard.netHeadroomPercent === null ? null : { label: text("상한", "guard"), value: guard.guardPercent },
              outstandingClaimPercent: guard.outstandingClaimPercent,
              netHeadroomPercent: guard.netHeadroomPercent,
            }, text)}
          </span>
        ))}
      </small>
      <div className="usage-budget-modal-row-controls">
        <BudgetCommitNumberField
          inline
          label={text("목표 override", "Target override")}
          title={text("이 계정에만 적용되는 소진 상한(%). 비우면 기본 목표를 씁니다.", "Usage ceiling (%) for this account only. Leave empty to use the default target.")}
          value={account.targetPercent ?? ""}
          min={0}
          max={100}
          placeholder={text("기본", "default")}
          disabled={busy}
          onCommit={(raw) => onSetTarget(account, raw)}
        />
        <BudgetToggleField
          inline
          label={text("참여", "Enabled")}
          checked={account.pacingEnabled}
          disabled={busy}
          switchLabel={text(`${label} 페이싱 참여`, `Include ${label} in pacing`)}
          onChange={(checked) => void onToggle(account, checked)}
        />
      </div>
    </div>
  );
}

/**
 * 계정 풀 설정 모달. 계정별 목표 override와 참여 스위치만 다루고 바깥 초안 상태를 쓰지
 * 않으므로, 같은 계정 풀을 읽기로 보여 주는 AccountPoolSection 옆에 둔다.
 */
function AccountPoolModal({ snapshot, busy, onSetTarget, onToggle, onClose }: {
  snapshot: UsageBudgetSnapshot;
  busy: string | null;
  onClose: () => void;
} & AccountActions) {
  const { text } = useI18n();
  // 지금 몇 개가 후보인지는 이 모달을 여는 이유 자체인데, 닫고 카드로 돌아가야만 읽혔다.
  // 행을 하나씩 켜고 끄는 동안 같은 자리에서 따라 오르내리게 맨 위에 적는다.
  const enabled = pooledAccounts(snapshot.accounts).length;
  return (
    <Modal title={text("계정 풀 설정", "Account pool settings")} onClose={onClose} size="wide">
      <p className="usage-budget-modal-note">
        <strong>{text(`참여 ${enabled} / ${snapshot.accounts.length}`, `Enabled ${enabled} / ${snapshot.accounts.length}`)}</strong>
        {" "}
        {text(
          "참여를 켠 계정만 페이싱 후보가 됩니다. 목표 override는 그 계정에만 적용되는 상한이고, 비우면 기본 목표를 씁니다. 변경은 즉시 저장됩니다.",
          "Only accounts with participation on are pacing candidates. A target override caps that one account; leave it empty to use the default. Changes save immediately.",
        )}
      </p>
      <div className="usage-budget-modal-rows">
        {snapshot.accounts.length === 0
          ? <AccountPoolEmpty />
          : snapshot.accounts.map((account) => (
            <AccountPoolModalRow
              key={account.accountId}
              account={account}
              poolMates={quotaPoolMates(snapshot.accounts, account)}
              windowLabel={snapshot.windowLabel}
              busy={busy !== null}
              onSetTarget={onSetTarget}
              onToggle={onToggle}
            />
          ))}
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
      <BudgetModalSection title={text("페이싱을 멈출 시간대", "Quiet hours")} note={quietStatusText(snapshot, text)}>
        <div className="usage-budget-defaults quiet-hours-form">
          <BudgetToggleField
            label={text("제한 시간대 사용", "Use quiet hours")}
            checked={draft.enabled}
            disabled={busy !== null}
            switchLabel={text("제한 시간대 사용", "Use quiet hours")}
            onChange={(checked) => onChange({ ...draft, enabled: checked })}
          />
          <BudgetGridField className="wide" label={text("페이싱을 멈출 시간대", "Quiet hours")}>
            <div className="time-range">
              <input type="time" value={draft.start} disabled={!draft.enabled} onChange={(event) => onChange({ ...draft, start: event.target.value })} />
              <b>~</b>
              <input type="time" value={draft.end} disabled={!draft.enabled} onChange={(event) => onChange({ ...draft, end: event.target.value })} />
            </div>
            {draft.enabled && draft.end < draft.start && (
              <small>{text(`다음 날 ${draft.end}까지 이어지는 제한입니다(자정 넘김, 시작 요일 기준).`, `Continues past midnight until ${draft.end} the next day (counted on the start day).`)}</small>
            )}
          </BudgetGridField>
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
      </BudgetModalSection>
    </Modal>
  );
}

/** 회차 카드의 공급자별 절감 한 줄. 지표·달성률·상한 초과·기준선 확정을 이어 붙인다. */
function savingsLine(report: UsageBudgetSavingsReport | undefined, provider: ProviderId, text: UiText): string | null {
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
  const ceiling = report.overCeiling ? text(` · 상한 초과(${report.overCeiling})`, ` · over ceiling (${report.overCeiling})`) : "";
  // 기준선이 확정된 뒤에야 달성률을 시점끼리 견줄 수 있다. 확정 전에는 그렇다고 말해 준다.
  const fixed = report.achievedReductionPercent === null
    ? ""
    : report.baselineFixedAt
      ? text(` · 기준선 ${formatDate(report.baselineFixedAt)} 확정`, ` · baseline fixed ${formatDate(report.baselineFixedAt)}`)
      : text(" · 기준선 미확정", " · baseline not fixed yet");
  return `${sourceName(provider)}: ${metric}${achieved}${ceiling}${fixed}`;
}

/**
 * 소비 성향 한 갈래가 화면에서 쓰이는 문구 전부 — 문장 안에 끼워 넣는 이름, 예산 기본값
 * 모달의 선택지, 회차 설정의 선택지, 셀렉트 아래 설명 한 줄. 네 자리가 각자 갈래 셋을
 * 열거하고 있어 성향을 하나 더하려면 네 곳을 같이 고쳐야 했고, 한 곳을 빠뜨리면 고를 수는
 * 있는데 이름이 비거나(`spendProfileLabel`의 null) 설명이 "성향 없음" 문구로 남는다.
 * 문구가 자리마다 다른 것은 그대로다 — 같은 말을 한 줄에 모아 두어야 어긋난 자리가 보인다.
 */
interface SpendProfileView {
  /** 문장 안에 끼워 넣는 이름. 영어는 소문자 — "Follow default (saver)"처럼 괄호 안에 든다. */
  name: string;
  /** 예산 기본값 모달의 선택지. */
  defaultsOption: string;
  /** 회차 설정의 선택지. 이름 뒤에 그 성향이 무엇을 하는지 덧붙인다. */
  consumerOption: string;
  /** 그 성향이 걸렸을 때 셀렉트 아래 뜨는 설명. */
  hint: string;
}

function spendProfileView(profile: SpendProfile, text: UiText): SpendProfileView {
  switch (profile) {
    case "saver":
      return {
        name: text("아껴쓰기", "saver"),
        defaultsOption: text("아껴쓰기", "Saver"),
        consumerOption: text("아껴쓰기 · 항상 최저", "Saver · always lowest"),
        hint: text(
          "항상 최저 등급으로 돕니다. 검증 게이트가 품질을 지키는 회차에 맞습니다.",
          "Always runs at the lowest rung. Fits rounds whose verification gate protects quality.",
        ),
      };
    case "goal":
      return {
        name: text("균형", "balanced"),
        defaultsOption: text("균형 (medium~high)", "Balanced (medium–high)"),
        consumerOption: text("균형 · medium~high", "Balanced · medium–high"),
        hint: text(
          "medium~high 사이에서 회전을 최대로 하는 등급으로 돕니다. 남는 예산이 있을 때만 올라갑니다.",
          "Runs between medium and high at whatever keeps the most rounds going, rising only when budget would otherwise expire.",
        ),
      };
    case "quality":
      return {
        name: text("품질 우선", "quality first"),
        defaultsOption: text("품질 우선", "Quality first"),
        consumerOption: text("품질 우선 · 여력 있으면 높게", "Quality first · high when there is headroom"),
        hint: text(
          "여력이 있으면 높은 등급으로 돕니다. 회당 소비가 서너 배까지 오를 수 있습니다.",
          "Runs high when headroom allows. Cost per run can be three to four times the lowest rung.",
        ),
      };
  }
}

/** 셀렉트가 그리는 순서. 아껴 쓰는 쪽부터 품질 쪽으로 늘어놓는다. */
const SPEND_PROFILE_ORDER: readonly SpendProfile[] = ["saver", "goal", "quality"];

/** 소비 성향의 표시 이름. 성향이 없으면 null(물려받음). */
function spendProfileLabel(profile: SpendProfile | null | undefined, text: UiText): string | null {
  return profile ? spendProfileView(profile, text).name : null;
}

/** 성향 셀렉트의 선택지 셋. 자리마다 문구가 달라 어느 칸을 쓸지 받는다. */
function SpendProfileOptions({ field, text }: {
  field: "defaultsOption" | "consumerOption";
  text: UiText;
}) {
  return (<>
    {SPEND_PROFILE_ORDER.map((profile) => (
      <option value={profile} key={profile}>{spendProfileView(profile, text)[field]}</option>
    ))}
  </>);
}

/**
 * 성향 셀렉트 아래 한 줄. 레인을 직접 잡아 둔 회차와 방금 성향을 해제한 회차는 레인 표가
 * 무엇을 하는지 먼저 말해 주고, 그 밖에는 지금 걸린 성향(없으면 물려받은 기본값)을 풀어 준다.
 */
function spendProfileHintText(laneCount: number, laneEditorOpen: boolean, profile: SpendProfile | null | undefined, text: UiText): string {
  if (laneCount > 0) {
    return text(
      `공급자 ${laneCount}곳을 직접 잡아 두었습니다. 성향을 고르면 그 설정이 지워지고 성향이 천장·바닥을 대신 잡습니다.`,
      `${laneCount} provider lane(s) are set by hand. Picking a profile clears them and lets the profile set the cap and floor.`,
    );
  }
  if (laneEditorOpen) {
    return text(
      "성향을 해제했습니다. 아래 표에서 잡은 공급자만 그 값을 쓰고, 하나도 잡지 않으면 다시 '기본값 따름'으로 섭니다.",
      "The profile is cleared. Only the lanes you set below use those values; set none and it falls back to following the default.",
    );
  }
  return profile
    ? spendProfileView(profile, text).hint
    : text("성향을 정하지 않으면 경계 없이 회전을 최대로 하는 등급을 고릅니다.", "Without a profile the planner maximizes rounds with no bounds.");
}

/**
 * 소진 모드 현황. 토글은 전역이지만 실제로 몰아 쓰는 계정은 쓸 수 있는 리셋 크레딧이 남은
 * 쪽뿐이라, 켜 두고도 아무 계정도 소진하지 않는 상태가 정상적으로 생긴다. 카드가 그 차이를
 * 말해 주지 않으면 켰는데 왜 그대로인지 알 수 없다.
 */
function DrainStatusCard({ snapshot }: { snapshot: UsageBudgetSnapshot }) {
  const { text } = useI18n();
  const drainReserve = snapshot.defaults.drainReserveCredits ?? 0;
  const drainOn = snapshot.defaults.drain === true;
  const pacedAccounts = snapshot.accounts.filter((account) => account.pacingEnabled);
  const drainingAccounts = pacedAccounts.filter((account) => account.overview?.drain?.spendable === true);
  // 크레딧은 있지만 남겨 둘 몫이라 손대지 않는 계정.
  const drainHeldAccounts = pacedAccounts.filter((account) =>
    account.overview?.drain?.spendable === false && (account.overview?.drain?.availableCount ?? 0) > 0);
  // 가장 이른 "이때까진 시작해야 한다" 시각. 실측이 없으면 계산되지 않아 비어 있다.
  const drainActBy = drainingAccounts
    .map((account) => account.overview?.drain?.actByAt ?? null)
    .filter((at): at is number => at !== null)
    .sort((a, b) => a - b)[0] ?? null;
  if (!drainOn) return null;
  return (
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
          {drainActBy !== null && ` · ${text("가장 이른 크레딧 마감", "Earliest credit deadline")} ${formatDateOnly(drainActBy)}`}
          {drainingAccounts.length > 0 && drainReserve > 0
            && ` · ${text(`${drainReserve}장은 남겨 둡니다`, `keeping ${drainReserve} in reserve`)}`}
        </small>
      </span>
    </div>
  );
}

/**
 * 예산 기본값 모달. 계정 풀·페이싱 스케줄과 달리 여기 값은 초안이고 저장을 눌러야 반영되므로,
 * 초안 두 벌과 저장 진행 표시를 패널에서 받아 그대로 비춘다. 저장 로직은 두 커맨드를 잇달아
 * 보내며 절반만 성공한 경우까지 다뤄야 해 패널에 남겨 두고, 이 컴포넌트는 화면만 맡는다.
 */
function BudgetDefaultsModal({ snapshot, draft, savings, busy, error, onDraftChange, onSavingsChange, onSave, onClose }: {
  snapshot: UsageBudgetSnapshot;
  draft: UsageBudgetDefaults | null;
  savings: SavingsDraft | null;
  busy: string | null;
  error: string | null;
  onDraftChange: Dispatch<SetStateAction<UsageBudgetDefaults | null>>;
  onSavingsChange: Dispatch<SetStateAction<SavingsDraft | null>>;
  onSave: () => void;
  onClose: () => void;
}) {
  const { text } = useI18n();
  return (
    <Modal
      title={text("예산 기본값", "Budget defaults")}
      onClose={onClose}
      footer={<>
        <button className="button" type="button" onClick={onClose} disabled={busy !== null}>{text("닫기", "Close")}</button>
        <button className="button primary" type="button" onClick={onSave} disabled={busy !== null}>
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
      <BudgetModalSection
        title={text("기본 목표·가드", "Default target and guard")}
        note={text(
          `현재 창 ${snapshot.windowLabel}, 회차 간격 ${snapshot.cadenceMinutes}분. 비워 두면 캡 없이 워크플로 인자를 그대로 씁니다. 소진 모드가 몰아 쓰는 중인 계정은 이 두 값 대신 100%를 씁니다.`,
          `Window ${runtimeCatalogText(snapshot.windowLabel)}, cadence ${snapshot.cadenceMinutes} min. Leave empty to use workflow arguments without a cap. Accounts the drain mode is currently draining use 100% instead of these two.`,
        )}
      >
        <div className="usage-budget-defaults">
          <BudgetGridField label={text("목표 사용률(%)", "Target (%)")}>
            <input type="number" min={0} max={100} value={draft?.targetPercent ?? ""} onChange={(event) => onDraftChange({ ...draft, targetPercent: parsePercent(event.target.value) })} />
          </BudgetGridField>
          <BudgetGridField label={text("채울 창", "Window")}>
            <input type="text" value={draft?.windowLabel ?? ""} placeholder={text("7일", "7 days")} onChange={(event) => onDraftChange({ ...draft, windowLabel: event.target.value })} />
          </BudgetGridField>
          <BudgetGridField label={text("함께 지킬 창", "Guard window")}>
            <input type="text" value={draft?.guardWindowLabel ?? ""} placeholder={text("5시간", "5 hours")} onChange={(event) => onDraftChange({ ...draft, guardWindowLabel: event.target.value })} />
          </BudgetGridField>
          <BudgetGridField label={text("가드 상한(%)", "Guard (%)")}>
            <input type="number" min={0} max={100} value={draft?.guardPercent ?? ""} onChange={(event) => onDraftChange({ ...draft, guardPercent: parsePercent(event.target.value) })} />
          </BudgetGridField>
          <BudgetGridField
            label={text("기본 소비 성향", "Default spend profile")}
            title={text("성향을 정하지 않은 회차가 물려받는 값입니다. 없으면 계정 여력만 보고 사다리의 기준칸(high)에서 오르내립니다.", "Rounds without their own profile inherit this. Without it the ladder moves around its anchor (high) on headroom alone.")}
          >
            <select
              value={draft?.spendProfile ?? ""}
              onChange={(event) => onDraftChange({ ...draft, spendProfile: (event.target.value || null) as SpendProfile | null })}
            >
              <option value="">{text("없음 (자동·경계 없음)", "None (auto, no bounds)")}</option>
              <SpendProfileOptions field="defaultsOption" text={text} />
            </select>
          </BudgetGridField>
        </div>
      </BudgetModalSection>
      <BudgetModalSection
        title={text("회당 소비 추이", "Cost per run trend")}
        note={text(
          "소비자별로 처음 N회 관측의 중앙값을 기준선으로 한 번 붙박고, 회당 소비가 그 뒤로 어떻게 움직였는지 보여 줍니다. Claude는 실제 토큰, Codex는 창 %p로 잽니다. 추이만 보는 값입니다 — 등급은 회차 회전을 최대로 하도록 계획이 직접 고르므로 따로 목표를 정하지 않습니다.",
          "The baseline is fixed once from the median of each consumer's first N runs and shows how per-run cost moved since. Claude uses real tokens, Codex uses window %. It is a trend readout only — the planner picks the effort that keeps the most rounds running, so there is no target to set.",
        )}
      >
        <div className="usage-budget-defaults">
          <BudgetGridField label={text("기준선 회차 수 (1~32)", "Baseline runs (1–32)")}>
            <input type="number" min={1} max={32} value={savings?.baselineRuns ?? ""} placeholder="5" onChange={(event) => onSavingsChange({ targetReductionPercent: savings?.targetReductionPercent ?? null, baselineRuns: parseCount(event.target.value) })} onBlur={() => onSavingsChange((current) => current?.baselineRuns == null ? current : { ...current, baselineRuns: clampBaselineRuns(current.baselineRuns) })} />
          </BudgetGridField>
        </div>
      </BudgetModalSection>
      <BudgetModalSection
        title={text("소진 모드", "Drain mode")}
        note={text(
          "쓸 수 있는 크레딧이 남은 계정은 채울 창과 짧은 창을 모두 100%까지, 시간에 직선으로 펴지 않고 몰아 써서 빨리 비우고, 비워진 창을 한도 리셋 크레딧으로 되돌린 뒤 다시 채웁니다. 공급자는 소진되지 않은 창에는 크레딧을 쓰지 못하게 물리므로, 목표 사용률에서 멈추면 크레딧을 쓸 길이 없어집니다 — 그래서 소진 중인 계정만 위의 목표·가드를 따르지 않습니다. 크레딧이 없거나 남겨 둘 장수만 남은 계정은 목표·가드와 균등 소비 그대로 둡니다 — 되돌릴 수단 없이 한도만 일찍 태우면 남은 기간 내내 그 계정이 멈춥니다. 페이싱 스케줄은 그대로 지키고, 추론수준도 바꾸지 않습니다.",
          "Accounts with spendable credits fill both the target window and the short window to 100%, as fast as they can rather than spread evenly, then restore the emptied window with a rate limit reset credit and fill it again. The provider refuses to spend a credit on a window that is not used up, so stopping at the target leaves no way to use one — that is why draining accounts alone ignore the target and guard above. Accounts without spendable credits keep the target, the guard, and even pacing — draining with no way back strands them for the rest of the period. The pacing schedule still applies, and the effort level is left alone.",
        )}
      >
        <div className="usage-budget-defaults">
          {/* 켜고 끄는 자리라 설정 화면 공용 스위치를 쓴다. 스위치는 버튼이라 label로
              감싸지 않고, 옆 칸들과 같은 열 모양은 CSS가 맞춘다. */}
          <div className="usage-budget-drain-toggle">
            <span>{text("소진 모드", "Drain mode")}</span>
            <em>
              <AppToggle
                checked={draft?.drain ?? false}
                label={text("소진 모드", "Drain mode")}
                onChange={(next) => onDraftChange({ ...draft, drain: next })}
              />
              {(draft?.drain ?? false)
                ? text("몰아 쓰고 되돌림", "Drain and restore")
                : text("균등 소비", "Even pacing")}
            </em>
          </div>
          <BudgetGridField
            label={text("남겨 둘 크레딧", "Credits to keep")}
            title={text(
              "소진 모드가 자동으로 쓰지 않고 남겨 둘 리셋 크레딧 장수입니다. 사람이 급할 때 직접 쓸 몫이며, 남은 장수가 여기에 닿은 계정은 소진 대상에서 빠집니다.",
              "Reset credits the drain mode never spends on its own — your manual reserve. Accounts down to this count drop out of draining.",
            )}
          >
            <input
              type="number"
              min={0}
              value={draft?.drainReserveCredits ?? ""}
              placeholder="0"
              disabled={!(draft?.drain ?? false)}
              onChange={(event) => onDraftChange({
                ...draft,
                drainReserveCredits: event.target.value.trim() === "" ? null : Math.max(0, Number(event.target.value)),
              })}
            />
          </BudgetGridField>
        </div>
      </BudgetModalSection>
    </Modal>
  );
}


/** 사다리 한 벌을 셀렉트 선택지로 편다. 레인 표의 세 칸이 같은 사다리를 각자 펼치고 있었다. */
function EffortLadderOptions({ ladder, label }: {
  ladder: ReasoningEffort[];
  label: (effort: ReasoningEffort) => string;
}) {
  return <>{ladder.map((effort) => <option key={effort} value={effort}>{label(effort)}</option>)}</>;
}

/**
 * 레인의 자동 경계 칸(자동 상한·자동 바닥). 두 칸은 이름·설명과 고치는 자리(`maxAuto`·`minAuto`)만
 * 다를 뿐 값 계산(고정이 걸려 있으면 빈 값), 비활성 조건(바쁨이거나 고정), 선택지가 같은
 * 손복사본이었다 — 한쪽에서만 "없음" 표기나 고정일 때의 처리를 고치면 다른 쪽이 조용히 뒤처진다.
 */
function LaneAutoBoundField({ label, title, fixed, bound, ladder, disabled, onChange }: {
  label: string;
  /** 칸 이름에 붙는 설명. 자동 상한처럼 설명이 없는 칸은 주지 않는다. */
  title?: string;
  /** 이 레인에 걸린 고정 등급. 걸려 있으면 자동 경계는 뜻이 없어 빈 값으로 잠근다. */
  fixed: LaneReasoningEffort["fixed"];
  bound: LaneReasoningEffort["maxAuto"];
  ladder: ReasoningEffort[];
  disabled: boolean;
  onChange: (value: string | null) => void;
}) {
  const { text } = useI18n();
  return (
    <BudgetField label={label} title={title}>
      <select
        value={fixed ? "" : bound ?? ""}
        disabled={disabled || Boolean(fixed)}
        onChange={(event) => onChange(event.target.value || null)}
      >
        <option value="">{text("없음", "None")}</option>
        <EffortLadderOptions ladder={ladder} label={reasoningLabel} />
      </select>
    </BudgetField>
  );
}

/**
 * 회차 하나가 쓸 수 있는 계정과 그중 실제로 참여하는 계정. 후보 계산("풀이 있으면 풀,
 * 없으면 전 계정")과 빈 집합 규칙("저장소의 빈 집합은 제한 없음")이 설정 모달 안에 풀려 있어
 * 추론수준 레인과 참여 계정 스위치가 각각 그 결과를 인자 두 개로 나눠 받고 있었다. 규칙은
 * 여기 한 번만 두고, 쓰는 자리는 결과 한 벌만 받는다.
 */
interface WorkflowAccountSelection {
  /** 이 회차가 고를 수 있는 계정 후보. */
  selectable: UsageBudgetAccount[];
  /** 후보의 accountId 순서 그대로. */
  selectableIds: string[];
  /** 지금 참여하는 계정. 제한이 없으면 후보 전체와 같다. */
  selectedIds: string[];
  /** 저장된 집합이 비어 "제한 없음"인 상태. */
  unrestricted: boolean;
}

function workflowAccountSelection(consumer: UsageBudgetConsumer, snapshot: UsageBudgetSnapshot): WorkflowAccountSelection {
  // 워크플로별 참여 계정의 선택지. 풀이 있으면 풀 안에서 고르고, 없으면 전 계정이 후보다.
  const pool = pooledAccounts(snapshot.accounts);
  const selectable = pool.length > 0 ? pool : snapshot.accounts;
  const selectableIds = selectable.map((account) => account.accountId);
  // 저장소의 빈 집합은 "제한 없음"이다. 화면에서는 전부 켜진 것과 같으므로 후보 전체로 편다 —
  // 필드를 모르는 옛 백엔드 응답도 같은 규칙으로 읽힌다.
  const unrestricted = (consumer.workflowAccounts ?? []).length === 0;
  const selectedIds = unrestricted
    ? selectableIds
    : selectableIds.filter((id) => consumer.workflowAccounts.includes(id));
  return { selectable, selectableIds, selectedIds, unrestricted };
}

/**
 * 스위치 한 번의 결과. 후보를 전부 고른 상태는 저장소에서 "제한 없음"(빈 집합)과 같은 뜻이라
 * 그때만 빈 배열로 접는다 — 이 되돌림이 JSX 한 줄에 묻혀 있어 규칙이 보이지 않았다.
 */
function nextWorkflowAccounts(accounts: WorkflowAccountSelection, accountId: string, checked: boolean): string[] {
  const next = checked
    ? accounts.selectableIds.filter((id) => id === accountId || accounts.selectedIds.includes(id))
    : accounts.selectedIds.filter((id) => id !== accountId);
  return next.length === accounts.selectableIds.length ? [] : next;
}

/** 회차 설정 모달의 참여 계정 스위치 목록. 켜고 끄는 즉시 저장된다. */
function ConsumerWorkflowAccounts({ accounts, busy, onChange }: {
  accounts: WorkflowAccountSelection;
  busy: string | null;
  onChange: (next: string[]) => void;
}) {
  const { text } = useI18n();
  return (
    <div className="usage-budget-workflow-accounts">
      <header>
        <strong>{text("참여 계정", "Accounts")}</strong>
        <small>
          {accounts.unrestricted
            ? text("제한이 없어 풀에 켜진 계정을 모두 씁니다. 하나라도 끄면 남은 계정만 이 회차에 쓰이고, 끄는 즉시 저장됩니다.", "Unrestricted — every enabled account in the pool is used. Turn one off and only the rest run this round; it saves immediately.")
            : text(`${accounts.selectedIds.length}개 계정만 이 회차에 쓰입니다. 마지막 한 계정은 끌 수 없고, 바꾸는 즉시 저장됩니다.`, `Only ${accounts.selectedIds.length} account(s) run this round. The last one cannot be turned off, and changes save immediately.`)}
        </small>
      </header>
      <ul className="usage-budget-account-switches">
        {accounts.selectable.map((account) => {
          const selected = accounts.selectedIds.includes(account.accountId);
          // 전부 빼면 저장소의 빈 집합이 "제한 없음"으로 읽혀 의도와 반대가 된다.
          // 마지막 한 계정은 누르지 못하게 스위치를 잠가, 눌러도 아무 일이 없는
          // 대신 왜 못 끄는지가 모양으로 보이게 한다.
          const locked = selected && accounts.selectedIds.length <= 1;
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
                onChange={(checked) => onChange(nextWorkflowAccounts(accounts, account.accountId, checked))}
              />
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * 회차 설정 모달의 소비 성향·추론수준 레인 표. 이 구역만 쓰는 파생값(잡아 둔 레인, '직접
 * 설정'으로 서 있는지, 레인으로 보일 공급자, 공급자별 사다리)이 패널 본문의 파생값 더미에
 * 섞여 있어, 모달과 상관없는 코드를 읽을 때도 따라다녔다. 값과 그 값을 쓰는 화면을 한자리에
 * 둔다. 성향·레인의 저장은 그대로 패널이 맡는다 — 저장은 스냅샷을 다시 읽어야 해서다.
 */
function ConsumerEffortSection({ consumer, snapshot, busy, customProfileOpen, accounts, onSetSpendProfile, onSetLaneEffort }: {
  consumer: UsageBudgetConsumer;
  snapshot: UsageBudgetSnapshot;
  busy: string | null;
  /** 셀렉트에서 방금 '직접 설정'을 고른 회차인지. 잡아 둔 레인이 없어도 표를 열어 둔다. */
  customProfileOpen: boolean;
  accounts: WorkflowAccountSelection;
} & ConsumerEffortActions) {
  const { text } = useI18n();
  // 손으로 잡아 둔 레인. 하나라도 있으면 '직접 설정'이고 프리셋은 그 위를 덮지 않는다.
  const laneOverrides = Object.keys(consumer.reasoningEfforts ?? {});
  const laneEditorOpen = laneOverrides.length > 0 || customProfileOpen;
  const defaultProfileLabel = spendProfileLabel(snapshot.defaults.spendProfile, text);
  // 추론수준 레인 = 이 회차가 쓰는 계정들의 공급자. 계정을 못 읽는 상태면 세 공급자를 다 보인다.
  const effortLaneProviders = PACING_PROVIDER_IDS.filter((provider) =>
    accounts.selectable.some((account) => account.provider === provider && accounts.selectedIds.includes(account.accountId)));
  // 폴백도 페이싱 공급자만 본다 — 계정을 못 읽는다고 해서 사용량 한도가 없는 공급자의
  // 레인까지 그리면, 고를 수도 저장할 수도 없는 칸이 생긴다.
  const effortLanes = effortLaneProviders.length > 0 ? effortLaneProviders : PACING_PROVIDER_IDS;
  const effortLadder = (provider: ProviderId) => snapshot.reasoningEffortLadders?.[provider] ?? FALLBACK_EFFORT_LADDERS[provider];
  return (
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
      <BudgetField label={text("성향", "Profile")}>
        <select
          value={laneEditorOpen ? "custom" : consumer.spendProfile ?? "inherit"}
          disabled={busy !== null}
          onChange={(event) => onSetSpendProfile(consumer, event.target.value)}
        >
          <option value="inherit">{text(`기본값 따름${defaultProfileLabel ? ` (${defaultProfileLabel})` : ""}`, `Follow default${defaultProfileLabel ? ` (${defaultProfileLabel})` : ""}`)}</option>
          <SpendProfileOptions field="consumerOption" text={text} />
          <option value="custom">{text("직접 설정…", "Custom…")}</option>
        </select>
      </BudgetField>
      <small className="usage-budget-lane-hint">
        {spendProfileHintText(
          laneOverrides.length,
          laneEditorOpen,
          consumer.spendProfile ?? snapshot.defaults.spendProfile,
          text,
        )}
      </small>
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
          const lane = consumer.reasoningEfforts?.[provider] ?? {};
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
                <BudgetField label={text("방식", "Mode")}>
                  <select
                    value={lane.fixed ?? "auto"}
                    disabled={busy !== null}
                    onChange={(event) => onSetLaneEffort(consumer, provider, { fixed: event.target.value === "auto" ? null : event.target.value })}
                  >
                    <option value="auto">{text("자동 (계정 여력)", "Auto (account headroom)")}</option>
                    <EffortLadderOptions ladder={ladder} label={(effort) => text(`고정 · ${reasoningLabel(effort)}`, `Fixed · ${effort}`)} />
                  </select>
                </BudgetField>
                <LaneAutoBoundField
                  label={text("자동 상한", "Auto cap")}
                  fixed={lane.fixed}
                  bound={lane.maxAuto}
                  ladder={ladder}
                  disabled={busy !== null}
                  onChange={(value) => onSetLaneEffort(consumer, provider, { maxAuto: value })}
                />
                <LaneAutoBoundField
                  label={text("자동 바닥", "Auto floor")}
                  title={text("절감 목표와 상한 초과가 등급을 내릴 때 여기서 멈춥니다.", "The savings goal and ceiling stop lowering the effort here.")}
                  fixed={lane.fixed}
                  bound={lane.minAuto}
                  ladder={ladder}
                  disabled={busy !== null}
                  onChange={(value) => onSetLaneEffort(consumer, provider, { minAuto: value })}
                />
              </div>
            </li>
          );
        })}
      </ul>
      </>)}
    </div>
  );
}

/**
 * 회차 카드의 접히는 상세정보. 카드 한 벌이 240줄을 넘겨 머리말 한 칸을 고칠 때도 상세
 * 표·소비 절 전체를 지나쳐야 했다 — 펼쳤을 때만 그려지고 카드의 상태를 바꾸지 않는
 * 이 영역부터 떼어낸다. 계산은 그대로 `consumerCardView`의 결과를 받아 쓴다.
 */
function ConsumerRoundDetails({ consumer, snapshot, view, detailsId }: {
  consumer: UsageBudgetConsumer;
  snapshot: UsageBudgetSnapshot;
  view: ConsumerCardView;
  detailsId: string;
}) {
  const { text } = useI18n();
  const { tally, triggerPaused, summary, accountCostGroups, accountCostCount, effortCosts, effortGroups } = view;
  return (
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
        <Metric
          label={text("완료조건", "Completion")}
          title={text(
            "회차 봉투가 매 기동 메시지 끝에 조건과 누적 성공 건수를 덧붙이고, 실행 에이전트가 충족을 판단하면 마지막 줄의 PACING_COMPLETE 표식으로 알립니다. 그 순간 회차가 완료되어 예약 기동이 멈춥니다.",
            "The round envelope appends the condition and the running success count to every launch message. When the agent judges it met, it ends its reply with a PACING_COMPLETE line and the round completes — no more scheduled launches.",
          )}
          value={consumer.completionCondition
            ? (consumer.completionConditionEnabled === false
              // 꺼 둔 조건은 문구만 보관된 상태다. 문구를 그대로 보여 주면 적용 중으로 읽힌다.
              ? text("사용 꺼짐", "off")
              : consumer.completionCondition)
            : text("없음", "none")}
          note={view.completed
            ? `${text("완료", "completed")} · ${consumer.completedAt ? formatDateTime(consumer.completedAt) : ""}${consumer.completionNote ? ` · ${consumer.completionNote}` : ""}`
            : text(`누적 성공 ${consumer.completedRuns ?? 0}건`, `${consumer.completedRuns ?? 0} successful run(s)`)}
        />
        <Metric label={text("평균 소진율", "Average used")} value={percent(summary.averageUsedPercent, 0)} note={runtimeCatalogText(snapshot.windowLabel)} />
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
        <AgentCostSection
          title={text("추론수준별 회당 소비", "Cost per run by effort")}
          unit={{ noun: text("등급", "levels"), en: "levels" }}
          total={effortCosts.length}
          groups={effortGroups}
          describe={(cost) => ({
            key: `${cost.provider}:${cost.reasoningEffort}`,
            label: reasoningLabel(cost.reasoningEffort),
          })}
        />
      )}
      {accountCostCount > 1 && (
        // 여러 계정(에이전트)으로 돈 회차는 계정마다 회당 토큰·소비를 따로 보여 준다.
        // 한 계정뿐이면 위 공급자별 값과 같아 겹쳐 그리지 않는다. 여러 계정은
        // 공급자별로 묶고 수치 열을 고정해 긴 이메일이 옆 값을 밀어내지 않게 한다.
        <AgentCostSection
          title={text("계정별 회당 소비", "Cost per run by account")}
          unit={{ noun: text("계정", "accounts"), en: "accounts" }}
          total={accountCostCount}
          groups={accountCostGroups}
          describe={(cost) => {
            const account = snapshot.accounts.find((item) => item.accountId === cost.accountId);
            const accountName = account ? accountLabel(account) : cost.accountId;
            return { key: `${cost.provider}:${cost.accountId}`, label: accountName, title: accountName };
          }}
        />
      )}
      {PACING_PROVIDER_IDS.map((provider) => {
        const line = savingsLine(consumer.costs?.savings?.[provider], provider, text);
        return line ? <small className="usage-budget-savings-line" key={provider}>{line}</small> : null;
      })}
    </div>
  );
}

/**
 * 회차 카드의 조작 줄. 실행·정지·삭제는 트리거를 읽었을 때만 걸 수 있고 편집만 언제나
 * 열린다는 규칙이 카드 본문 끝에 묻혀 있었다. 버튼과 그 사용 가능 조건을 한자리에 모은다.
 */
function ConsumerRoundActions({ view, busy, onTriggerAction, onEdit, onRemoveTrigger, onRestart }: {
  view: ConsumerCardView;
  busy: string | null;
  onTriggerAction: TriggerAction;
  onEdit: () => void;
  onRemoveTrigger: (trigger: ScheduledRequest) => Promise<void>;
  /** 완료된 회차를 다시 진행중으로 돌린다(완료 상태·누적 건수 초기화, 트리거가 꺼져 있으면 켬). */
  onRestart: () => void;
}) {
  const { text } = useI18n();
  const { trigger, runActive, runQueued, triggerPaused, completed, runButtonLabel } = view;
  // 편집은 되돌릴 수 있는 조작이라 지우기 바로 왼쪽에 둔다. 실행·정지는
  // 트리거를 읽었을 때만 걸 수 있고, 편집은 트리거를 못 읽어도 열린다.
  // 완료된 회차는 실행·일시정지 대신 "다시 시작" 하나만 둔다 — 지금 실행은 기동 게이트가
  // 거절하고, 일시정지는 이미 돌지 않는 회차에 뜻이 없다.
  return (
    <div className="usage-budget-card-actions">
      {trigger && completed && (
        <button
          className="button"
          type="button"
          disabled={busy !== null}
          onClick={onRestart}
        >
          {text("다시 시작", "Restart")}
        </button>
      )}
      {trigger && !completed && (<>
        <button
          className="button"
          type="button"
          disabled={busy !== null || runActive || runQueued}
          onClick={() => void onTriggerAction(`trigger:${trigger.id}`, () => runScheduledRequestNow(trigger.id))}
        >
          {runButtonLabel}
        </button>
        <button
          className="button"
          type="button"
          disabled={busy !== null}
          onClick={() => void onTriggerAction(`trigger:${trigger.id}`, () => setScheduleEnabled(trigger.id, triggerPaused))}
        >
          {triggerPaused ? text("재개", "Resume") : text("일시정지", "Pause")}
        </button>
      </>)}
      <button
        className="button"
        type="button"
        disabled={busy !== null}
        onClick={onEdit}
      >
        {text("편집", "Edit")}
      </button>
      {trigger && (
        <button
          className="button danger-subtle"
          type="button"
          disabled={busy !== null}
          onClick={() => void onRemoveTrigger(trigger)}
        >
          {text("삭제", "Delete")}
        </button>
      )}
    </div>
  );
}

/**
 * 회차 카드의 제목 줄. 배지 넷(활성·비활성·페이싱 미사용·구형 계약)과 부제 한 줄이
 * 카드 본문 맨 위에 스무 줄 가까이 붙어 있어, 아래 지표·경고·상세를 보려면 먼저 이
 * 마크업을 지나야 했다. 파생값은 이미 `consumerCardView`가 다 계산해 두었으므로, 지표
 * 줄(`Metric`)과 같은 층으로 떼어낸다 — 구형 계약 배지의 판정까지 그리로 옮겨 이 조각은
 * 카드 뷰와 소비자만 읽는다.
 */
function ConsumerRoundHead({ consumer, view }: {
  consumer: UsageBudgetConsumer;
  view: ConsumerCardView;
}) {
  const { text } = useI18n();
  const { isActive, trigger, triggerPaused, completed, sprint, label, summary, legacyContractPacing } = view;
  // 회차 상태는 셋 중 하나다: 완료(조건 충족, 기동 없음) › 일시정지(트리거 꺼짐) › 진행중.
  // 완료가 먼저다 — 완료된 회차는 트리거가 켜져 있어도 돌지 않으므로 "진행중"으로 읽히면 안 된다.
  const state = completed
    ? { className: "skill-sync-pill current", label: text("완료", "completed") }
    : triggerPaused
      ? { className: "skill-sync-pill partial", label: text("일시정지", "paused") }
      : (trigger || isActive)
        ? { className: "skill-sync-pill on", label: text("진행중", "in progress") }
        : null;
  return (
    <div className="usage-budget-card-head">
      <div>
        <strong>
          {/* 상태는 이 카드를 읽을지 말지를 먼저 가르는 값이라 제목 왼쪽에 둔다.
              제목 오른쪽에 두면 이름 길이에 따라 배지 위치가 카드마다 달라져 훑기 어렵다. */}
          {state && <em className={state.className} data-round-state={completed ? "completed" : triggerPaused ? "paused" : "running"}>{state.label}</em>}
          {label}
          {sprint && <em className="skill-sync-pill on" title={text("계획 창 목표를 무시하고 가드 창이 허락하는 만큼 몰아 돕니다", "Ignores the plan-window target and runs as hard as the guard window allows")}>{text("스프린트", "sprint")}</em>}
          {consumer.paced === false && <em className="skill-sync-pill partial">{text("페이싱 미사용 · 기동만 통제", "unpaced · launch gate only")}</em>}
          {legacyContractPacing && <em className="skill-sync-pill partial">{text("계약 내 페이싱 · 구형", "in-contract pacing · legacy")}</em>}
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
  );
}

/**
 * "이 설정으로는 목표를 못 채운다"는 경고. 카드 본문 한가운데에서 조건과 세 갈래 문구가
 * 스무 줄을 차지해, 그 위아래의 지표 줄과 상세 토글이 한 화면에 들어오지 않았다. 판정은
 * 백엔드가 준 처리량 값만 보므로 조건째로 옮기고, 그릴 것이 없으면 스스로 `null`을
 * 돌려준다 — 호출부에는 조건이 남지 않는다.
 */
function ConsumerThroughputWarning({ view }: { view: ConsumerCardView }) {
  const { text } = useI18n();
  const { throughput, ownThroughput } = view;
  if (!throughput || !ownThroughput || throughput.reachesTarget) return null;
  return (
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
  );
}

/**
 * 회차 한 건의 카드. 패널 본문 한가운데에 220줄짜리 JSX로 들어 있어 계정 풀 구역과 모달
 * 사이에서 어디까지가 한 회차인지 읽히지 않았고, 카드가 쓰는 값(카드 뷰·상세 펼침·트리거
 * 손잡이)이 패널의 다른 상태와 같은 자리에 섞여 있었다. 상태는 그대로 패널이 들고, 여기서는
 * 한 회차의 값과 조작 손잡이만 받아 그린다 — 그리는 내용과 조건은 옮기기 전과 같다.
 */
function ConsumerRoundCard({
  consumer, snapshot, workflows, rounds, pacingOn, busy,
  detailsOpen, onToggleDetails, onTriggerAction, onEdit, onRemoveTrigger, onRestart,
}: {
  consumer: UsageBudgetConsumer;
  snapshot: UsageBudgetSnapshot;
  workflows: SystemWorkflowSummary[];
  rounds: RoundIndex;
  pacingOn: boolean;
  busy: string | null;
  detailsOpen: boolean;
  onToggleDetails: () => void;
  onTriggerAction: TriggerAction;
  onEdit: () => void;
  onRemoveTrigger: (trigger: ScheduledRequest) => Promise<void>;
  onRestart: () => void;
}) {
  const { text } = useI18n();
  const view = consumerCardView({ consumer, snapshot, rounds, workflows, pacingOn, text });
  const { detailSummary } = view;
  const detailsId = `usage-budget-details-${consumer.scheduleId}`;
  return (
    <article className={`usage-budget-card${consumer.enabled === false ? " muted" : ""}`} data-schedule-id={consumer.scheduleId}>
      <ConsumerRoundHead consumer={consumer} view={view} />
      <dl className="usage-budget-metrics" aria-label={text("기본 정보", "Basic info")}>
        <Metric label={text("반복주기", "Cadence")} value={view.cadenceValue} note={view.cadenceNote} />
        <Metric label={text("다음 실행", "Next run")} value={view.nextRunValue} note={view.nextRunNote} />
        <Metric label={text("최근 실행", "Last run")} value={view.lastRunValue} note={view.lastRunNote} />
      </dl>
      <ConsumerThroughputWarning view={view} />
      {/* 상세정보는 "이 회차가 지금 어떤 상태인가"를 읽은 다음에 보는 값들이다. 좁은 폭에서는
          이만큼이 세로로 쌓여 카드 하나가 화면을 넘기므로 처음부터 접어 둔다. */}
      <button
        className="usage-budget-detail-toggle"
        type="button"
        aria-expanded={detailsOpen}
        aria-controls={detailsId}
        onClick={onToggleDetails}
      >
        {detailsOpen ? <ChevronDown size={13} aria-hidden /> : <ChevronRight size={13} aria-hidden />}
        {text("상세정보", "Details")}
        <small>{detailSummary}</small>
      </button>
      {detailsOpen && (
        <ConsumerRoundDetails consumer={consumer} snapshot={snapshot} view={view} detailsId={detailsId} />
      )}
      <ConsumerRoundActions
        view={view}
        busy={busy}
        onTriggerAction={onTriggerAction}
        onEdit={onEdit}
        onRemoveTrigger={onRemoveTrigger}
        onRestart={onRestart}
      />
    </article>
  );
}

/**
 * 열려 있는 편집 모달. 예산 기본값·페이싱 스케줄·계정 풀은 한 개씩이고, 회차 설정은 소비자
 * id로, 새 회차 편집기는 워크플로 id로 대상을 고른다. 다섯 갈래가 따로 상태를 들 때는
 * "어느 하나만 열린다"가 어디에도 적혀 있지 않아 닫기 처리도 갈래마다 따로 흩어져 있었다.
 */
type BudgetModal =
  | { kind: "defaults" }
  | { kind: "schedule" }
  | { kind: "pool" }
  | { kind: "consumer"; scheduleId: string }
  /** 회차는 워크플로마다 하나이므로 만드는 자리는 "회차 없는 워크플로" 행뿐이고, 그 행이 대상을 정해 준다. */
  | { kind: "newRound"; workflowId: string };

/**
 * 소진 마감 안내. 지금 소진을 시작하지 않으면 그 크레딧은 만료로 사라지므로 한 번 알린다.
 * 백엔드가 이미 알린 크레딧에는 `actNow`를 내리지 않으므로 여기서는 확인 처리만 하면 된다 —
 * 스냅샷을 30초마다 다시 읽어도 같은 크레딧으로 다시 울리지 않는다.
 *
 * 스냅샷만 읽고 화면 상태를 하나도 건드리지 않는 곁다리 효과인데도 예산 상태 훅 한가운데
 * 끼어 있어, 초안·모달·트리거를 따라 읽던 사람이 여기서 한 번 끊겼다. 딸린 상태가 없으므로
 * 이름 붙은 효과 하나로 가른다.
 */
function useDrainExpiryNotice(snapshot: UsageBudgetSnapshot | null) {
  const { text } = useI18n();
  useEffect(() => {
    if (!snapshot) return;
    const due = snapshot.accounts.find((account) => account.overview?.drain?.actNow === true);
    if (!due?.overview?.drain) return;
    const drain = due.overview.drain;
    const expires = drain.nextExpiresAt === null
      ? ""
      : ` (${formatDateOnly(drain.nextExpiresAt)} ${text("만료", "expires")})`;
    void showNativeNotification(
      text("한도 리셋 크레딧 만료 임박", "Reset credit expiring soon"),
      `${due.displayName}: ${text("지금 소진 모드를 켜야 이 크레딧을 쓸 수 있습니다.", "Turn on drain mode now to use this credit.")}${expires}`,
    ).catch(() => undefined);
    // 알림을 띄웠다는 사실만 남긴다. 실패해도 회차나 화면을 막지 않는다.
    void acknowledgeDrainNotice(due.accountId, drain.creditId).catch(() => undefined);
  }, [snapshot, text]);
}

/**
 * 예산 스냅샷 옆에서 함께 읽는 스케줄러·워크플로 곁다리 조회. 반복 요청·최근 회차·워크플로
 * 목록 네 벌은 언제나 `loadTriggers` 한 번에 함께 채워지고 실패하면 함께 비워지는데, 상태
 * 선언만 예산 초안·모달 사이에 흩어져 있어 "이 넷은 한 덩어리"라는 것이 읽어서는 보이지
 * 않았다. 네 setter는 이 훅 밖으로 나가지 않으므로 호출부에는 읽을 값과 다시 읽는 방법만 남는다.
 *
 * 실패를 삼키는 규칙은 그대로다 — 트리거 정보는 부가 정보라 못 읽어도 예산 화면은 그대로
 * 쓰여야 하고, 오류 배너는 스냅샷 쪽 실패에만 쓴다.
 */
function useBudgetTriggers() {
  // 소비자의 트리거(반복 요청)까지 이 화면이 관리한다. 채팅 화면의 반복 요청 목록에는
  // 페이싱 워크플로 회차가 나오지 않으므로, 주기·활성·다음 실행이 여기서 보여야 한다.
  // 반복 요청별 최근 회차들(`recentRuns`)까지 한 색인에 담는다 — 마지막 한 건만 보면
  // "계속 초록인데 산출물이 없다"를 놓친다. 셋은 같은 조회에서 나오므로 함께 갈아 끼운다.
  const [rounds, setRounds] = useState<RoundIndex>(emptyRoundIndex);
  const [workflows, setWorkflows] = useState<SystemWorkflowSummary[]>([]);

  // 스냅샷을 새로 읽을 때마다 같이 읽는다 — 소비자 행은 스냅샷의 활성 여부와 트리거의
  // 다음 실행을 한 줄에 놓으므로, 한쪽만 새로 읽으면 "비활성"인데 다음 실행이 뜨는 식으로 어긋난다.
  const loadTriggers = useCallback(async () => {
    try {
      const [scheduler, workflowList] = await Promise.all([getSchedulerSnapshot(), getSystemWorkflows()]);
      // 스냅샷의 runs는 최신순이라 첫 항목이 그 반복 요청의 최근 실행이다.
      const { latest, recent } = indexScheduleRuns(scheduler.runs);
      setRounds({
        schedules: new Map(scheduler.schedules.map((schedule) => [schedule.id, schedule])),
        lastRuns: latest,
        recentRuns: recent,
      });
      setWorkflows(workflowList.workflows);
    } catch {
      setRounds(emptyRoundIndex());
      setWorkflows([]);
    }
  }, []);

  return { rounds, workflows, loadTriggers };
}

/**
 * 편집 모달이 쓰는 상태 한 벌 — 저장값을 비추는 초안 셋, 지금 열린 모달, 그리고 저장되지 않는
 * '직접 설정' 표시. 이 다섯은 서로만 참조하는 한 덩어리인데 예산 상태 훅 안에서 스냅샷 조회·
 * 바쁨 표시·계정과 소비자 저장 사이에 흩어져 있어, 어느 값이 화면에 그려지는 저장값이고 어느
 * 값이 모달이 들고 있는 미저장 입력인지 320줄을 끝까지 읽어야 갈라졌다. 초안을 되돌리는
 * 규칙(모달을 열 때·스냅샷을 새로 읽을 때)도 두 자리에 나뉘어 있어 한쪽만 고치면 화면의 값과
 * 저장값이 다른데도 같아 보인다 — 그 규칙을 이 훅 안에 함께 둔다.
 *
 * 스냅샷은 인자로 받는다. 초안은 언제나 저장값에서 나오지만, 저장을 부르는 일은 예산 훅이
 * 하므로 여기는 "무엇을 비출지"만 알고 "언제 저장하는지"는 모른다.
 */
function useBudgetDrafts(snapshot: UsageBudgetSnapshot | null) {
  const [defaultsDraft, setDefaultsDraft] = useState<UsageBudgetDefaults | null>(null);
  const [savingsDraft, setSavingsDraft] = useState<SavingsDraft | null>(null);
  // 페이싱 스케줄(제한 시간대) 초안. 스냅샷을 새로 읽을 때마다 저장값으로 되돌린다.
  const [quietDraft, setQuietDraft] = useState<QuietHours | null>(null);
  // 열려 있는 편집 모달 하나. 다섯 모달은 서로 겹쳐 뜨지 않으므로 상태도 하나면 된다.
  const [modal, setModal] = useState<BudgetModal | null>(null);
  /**
   * '직접 설정'을 고른 소비자 id. 이 값은 저장되는 설정이 아니라 레인 표를 여는 자리다 —
   * 저장본에서 '직접 설정'은 잡아 둔 레인이 하나라도 있다는 뜻이므로, 한 번도 잡은 적 없는
   * 회차는 표를 열지 못하면 성향 밖으로 나갈 길이 없다. 표에서 레인을 하나라도 잡으면
   * 저장본이 그 사실을 담아 이 상태가 없어도 '직접 설정'으로 선다.
   */
  const [customProfileFor, setCustomProfileFor] = useState<string | null>(null);

  /**
   * 초안 셋을 저장값으로 맞춘다. 한 벌만 갱신하면 화면의 값과 저장값이 다른데도 같아 보인다.
   * 30초 자동 재조회는 일부러 이걸 쓰지 않는다(편집 중인 초안을 덮어쓰면 안 된다).
   */
  const syncDrafts = useCallback((next: UsageBudgetSnapshot) => {
    setDefaultsDraft(next.defaults);
    setSavingsDraft(savingsDraftFrom(next.savings));
    setQuietDraft(quietDraftFrom(next.defaults));
  }, []);

  /**
   * 예산 기본값만 저장된 절반 실패에서 그 절반을 화면에 비춘다. 절감 초안은 사용자가 친 값을
   * 지켜야 하므로 `syncDrafts`와 달리 건드리지 않는다(QA #56).
   */
  const syncSavedDefaults = useCallback((next: UsageBudgetSnapshot) => {
    setDefaultsDraft(next.defaults);
    setQuietDraft(quietDraftFrom(next.defaults));
  }, []);

  /**
   * 모달을 연다. 갈래마다 다른 것은 열기 전에 초안을 저장값으로 되돌리는 준비뿐이라 그 준비만
   * 여기서 갈라 두고, 열고 닫는 조작 자체는 한 쌍(`openModal`·`closeModal`)으로 둔다.
   * 초안은 패널 상태에 살아 있어 모달을 닫아도 지워지지 않는다 — 저장하지 않고 닫았다 다시
   * 열면 방금 지운 입력이 그대로 남아, 화면의 값과 실제 저장값이 다른데도 같아 보인다.
   * '직접 설정'은 저장되지 않는 표시라 모달을 드나들 때마다 함께 비운다 — 남겨 두면 레인을
   * 하나도 잡지 않고 닫은 회차가 다음에 열 때도 성향이 걸려 있지 않은 것처럼 보인다.
   */
  const openModal = (next: BudgetModal) => {
    // 초안을 되돌려야 하는 두 갈래는 저장본이 없으면 열지 않는다 — 비울 기준값이 없다.
    if (next.kind === "defaults" || next.kind === "schedule") {
      if (!snapshot) return;
      if (next.kind === "defaults") {
        setDefaultsDraft(snapshot.defaults);
        setSavingsDraft(savingsDraftFrom(snapshot.savings));
      } else {
        setQuietDraft(quietDraftFrom(snapshot.defaults));
      }
    }
    setCustomProfileFor(null);
    setModal(next);
  };

  const closeModal = () => {
    setCustomProfileFor(null);
    setModal(null);
  };

  return {
    defaultsDraft, setDefaultsDraft, savingsDraft, setSavingsDraft, quietDraft, setQuietDraft,
    modal, openModal, closeModal, customProfileFor, setCustomProfileFor,
    syncDrafts, syncSavedDefaults,
  };
}

/**
 * 이 화면의 상태 한 벌 — 스냅샷·초안·모달 열림·트리거 조작을 든다. 화면 본체가 900줄 가까운
 * JSX라 상태와 조작이 그 앞에 붙어 있으면 어느 핸들러가 어느 칸을 고치는지 찾기 어려웠다.
 * 같은 화면 묶음의 `useWorkflowCatalog`·`useCypressFileEditor`와 같은 모양으로 가른다 —
 * 여기는 무엇이 바뀌는지, 아래 본체는 무엇이 그려지는지만 본다.
 */
/** 계정·소비자 한 건에 부분 수정을 실어 보내는 저장 한 번. 성공 여부만 돌아온다. */
type SaveAccount = (account: UsageBudgetAccount, patch: Partial<SetUsageBudgetAccountRequest>) => Promise<boolean>;
type SaveConsumer = (consumer: UsageBudgetConsumer, patch: Partial<SetUsageBudgetConsumerRequest>) => Promise<boolean>;

/**
 * 계정 한 줄의 조작 두 가지. 저장 한 번(`save`) 말고는 훅의 상태를 하나도 읽지 않으면서
 * 274줄짜리 훅 본문 한가운데 끼어 있어, 무엇이 조작이고 무엇이 그 조작을 굴리는 장치인지
 * 본문을 끝까지 읽어야 갈라졌다. 페이로드를 짓는 `accountRequest`와 같은 층이므로 모듈
 * 자리로 내린다 — 훅에는 저장 장치(`withBusy`·`load`·`apply`)만 남는다.
 */
function accountActions(save: SaveAccount) {
  return {
    toggleAccount: (account: UsageBudgetAccount, pacingEnabled: boolean) => save(account, { pacingEnabled }),

    setAccountTarget: (account: UsageBudgetAccount, raw: string) => {
      const targetPercent = parsePercent(raw);
      if (targetPercent === account.targetPercent) return;
      void save(account, { targetPercent });
    },
  };
}

/**
 * 소비자(회차) 한 벌의 조작 여섯 가지. 계정 쪽과 같은 이유로 모듈 자리에 둔다. 저장 말고
 * 훅에서 받는 것은 '직접 설정' 표를 여는 자리 하나뿐이다 — 저장되는 값이 아니라 화면 상태라
 * 여기서 만들지 않고 인자로 받는다.
 */
function consumerActions(save: SaveConsumer, openCustomProfile: (scheduleId: string | null) => void) {
  return {
    toggleConsumer: (consumer: UsageBudgetConsumer, enabled: boolean) => save(consumer, { enabled }),

    setConsumerPriority: (consumer: UsageBudgetConsumer, raw: string) => {
      // 빈 칸은 0으로 읽는다 — 우선순위에 "없음"이 없어 지우는 순간 가장 낮은 값이 된다.
      const value = parseNumberField(raw, 0);
      if (value === null) return;
      const priority = clampPercent(Math.round(value));
      if (priority === consumer.priority && consumer.enabled !== null) return;
      void save(consumer, { priority });
    },

    setConsumerCeiling: (consumer: UsageBudgetConsumer, field: "maxTokensPerRun" | "maxCostPercentPerRun", raw: string) => {
      // 빈 입력은 상한 해제(0), 숫자는 그대로. 생략(undefined)은 기존 값 유지라 쓰지 않는다.
      const value = parseNumberField(raw, 0);
      if (value === null || value < 0) return;
      if ((consumer[field] ?? 0) === value) return;
      void save(consumer, field === "maxTokensPerRun" ? { maxTokensPerRun: Math.round(value) } : { maxCostPercentPerRun: value });
    },

    toggleEnforce: (consumer: UsageBudgetConsumer, enforceCeiling: boolean) => save(consumer, { enforceCeiling }),

    toggleSprint: (consumer: UsageBudgetConsumer, sprint: boolean) => save(consumer, { sprint }),

    /**
     * 완료조건 문구를 저장한다. 빈 칸은 해제라 `null`을 실어 보낸다 — 칸을 빼면 백엔드가 기존
     * 값을 지키고, 해제하면 완료 상태도 함께 지워진다. 같은 문구면 저장하지 않는다.
     */
    setCompletionCondition: (consumer: UsageBudgetConsumer, raw: string) => {
      const next = raw.trim() === "" ? null : raw.trim();
      if (next === (consumer.completionCondition ?? null)) return;
      void save(consumer, { completionCondition: next });
    },

    /**
     * 완료조건 사용 스위치. 끄면 문구는 남긴 채 적용만 멈춘다 — 지우기와 달리 다시 켤 때 적어
     * 둔 문구를 그대로 쓴다. 완료 상태 해제는 백엔드가 같은 저장에서 함께 한다.
     */
    toggleCompletionCondition: (consumer: UsageBudgetConsumer, enabled: boolean) =>
      save(consumer, { completionConditionEnabled: enabled }),

    /**
     * 소비 성향을 바꾼다. 프리셋은 레인별 설정이 없는 공급자에만 적용되므로, 프리셋을 고르면
     * 손으로 잡아 둔 레인을 비워 준다 — 안 그러면 고른 성향이 아무 일도 하지 않은 것처럼 보인다.
     * '직접 설정'은 반대로 성향만 해제하고 레인 표를 열어 둔다(레인은 그 표에서 잡는다).
     * 두 경우 모두 성향에 `null`을 실어 보내야 해제된다 — 칸을 빼면 백엔드가 기존 값을 지킨다.
     */
    setSpendProfile: (consumer: UsageBudgetConsumer, value: string) => {
      if (value === "custom") {
        openCustomProfile(consumer.scheduleId);
        void save(consumer, { spendProfile: null });
        return;
      }
      openCustomProfile(null);
      void save(consumer, {
        spendProfile: value === "inherit" ? null : (value as SpendProfile),
        reasoningEfforts: {},
      });
    },

    /**
     * 레인 하나의 추론수준 설정을 바꿔 전체 맵을 다시 보낸다(백엔드는 주어진 맵으로 통째로 교체).
     * 고정을 걸면 자동 상한은 뜻이 없어 지우고, 둘 다 비면 항목을 없애 "자동·상한 없음"으로 돌린다.
     */
    setLaneReasoningEffort: (consumer: UsageBudgetConsumer, provider: ProviderId, patch: LaneReasoningEffort) => {
      const current = consumer.reasoningEfforts ?? {};
      const lane: LaneReasoningEffort = { ...(current[provider] ?? {}), ...patch };
      const next: Partial<Record<ProviderId, LaneReasoningEffort>> = { ...current };
      if (lane.fixed) next[provider] = { fixed: lane.fixed, maxAuto: null, minAuto: null };
      else if (lane.maxAuto || lane.minAuto) next[provider] = { fixed: null, maxAuto: lane.maxAuto ?? null, minAuto: lane.minAuto ?? null };
      else delete next[provider];
      // 레인을 손으로 건드리면 '직접 설정'이다 — 프리셋이 그 위를 덮어쓰지 않게 성향을 비운다.
      void save(consumer, { reasoningEfforts: next, spendProfile: null });
    },
  };
}

function useUsageBudget(active: boolean) {
  const { text } = useI18n();
  const { confirm, confirmDialog } = useConfirm();
  const [snapshot, setSnapshot] = useState<UsageBudgetSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const { rounds, workflows, loadTriggers } = useBudgetTriggers();
  const {
    defaultsDraft, setDefaultsDraft, savingsDraft, setSavingsDraft, quietDraft, setQuietDraft,
    modal, openModal, closeModal, customProfileFor, setCustomProfileFor,
    syncDrafts, syncSavedDefaults,
  } = useBudgetDrafts(snapshot);
  const { panelRef, detailOpen, toggleDetail } = useRoundDetailDisclosure();

  /** 새 스냅샷을 화면에 반영한다. 초안 세 벌은 저장값을 그대로 비추는 자리라 함께 갱신한다. */
  const commitSnapshot = useCallback((next: UsageBudgetSnapshot) => {
    setSnapshot(next);
    syncDrafts(next);
    setError(null);
  }, [syncDrafts]);

  useDrainExpiryNotice(snapshot);

  /**
   * 바쁨 표시와 실패 처리를 한 벌로 묶는다. 아래 load·apply·triggerAction이 모두
   * `setBusy(key)` → 실행 → 실패하면 오류 문구 적기 → `finally setBusy(null)`을 똑같이
   * 되풀이했고, 다르던 것은 성공했을 때 무엇을 하느냐뿐이었다. 성공 여부를 돌려주므로
   * 모달의 저장은 성공했을 때만 닫고, 실패하면 입력을 든 채 열려 있어 다시 시도할 수 있다.
   * 실행 뒤에 무엇을 더 읽을지(트리거만·전체)는 갈래마다 달라 호출부에 그대로 남겼다.
   */
  const withBusy = useCallback(async (key: string, action: () => Promise<void>) => {
    setBusy(key);
    let ok = false;
    try {
      await action();
      ok = true;
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(null);
    }
    return ok;
  }, []);

  const load = useCallback(async () => {
    await withBusy("load", async () => commitSnapshot(await getUsageBudget()));
    await loadTriggers();
  }, [commitSnapshot, loadTriggers, withBusy]);

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

  const apply = useCallback(async (key: string, action: () => Promise<UsageBudgetSnapshot>) => {
    const ok = await withBusy(key, async () => commitSnapshot(await action()));
    await loadTriggers();
    return ok;
  }, [commitSnapshot, loadTriggers, withBusy]);

  // 트리거 조작은 예산 스냅샷이 아니라 반복 요청을 바꾸므로, 성공 후 전체를 다시 읽는다.
  const triggerAction = useCallback(async (key: string, action: () => Promise<unknown>) => {
    await withBusy(key, async () => {
      await action();
      setError(null);
    });
    await load();
  }, [load, withBusy]);

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

  const { toggleAccount, setAccountTarget } = accountActions(saveAccount);
  const {
    toggleConsumer, setConsumerPriority, setConsumerCeiling, toggleEnforce,
    setSpendProfile, setLaneReasoningEffort, toggleSprint, setCompletionCondition,
    toggleCompletionCondition,
  } = consumerActions(saveConsumer, setCustomProfileFor);

  /**
   * 완료된 회차의 "다시 시작". 완료 상태·누적 건수를 지우고, 트리거가 꺼져 있으면 함께 켠다 —
   * 완료 뒤 사용자가 트리거까지 꺼 두었다면 완료만 지워도 회차는 돌지 않아 버튼이 헛돈다.
   */
  const restartConsumer = async (consumer: UsageBudgetConsumer) => {
    const ok = await saveConsumer(consumer, { resetCompletion: true });
    if (!ok) return;
    const trigger = rounds.schedules.get(consumer.scheduleId);
    if (trigger && !trigger.enabled) {
      await triggerAction(`trigger:${trigger.id}`, () => setScheduleEnabled(trigger.id, true));
    }
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
      closeModal();
      return;
    }
    // 절반만 저장된 경우: 목표·가드 쪽 저장본을 화면에 반영한다. 절감 초안은 사용자가 친 값을 지킨다.
    if (partial.snapshot !== null) {
      setSnapshot(partial.snapshot);
      syncSavedDefaults(partial.snapshot);
    }
  };

  const saveQuiet = async () => {
    if (!snapshot || !quietDraft) return;
    // 반대로 여기서는 예산 기본값의 저장된 값을 실어 보낸다 — 예산 기본값 모달의 미저장 초안을 끌어오지 않는다.
    const saved = await apply("schedule", () => setUsageBudgetPolicy(defaultsPayload(snapshot.defaults, quietDraft)));
    if (saved) closeModal();
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

  const pool = poolSummary(snapshot?.accounts ?? []);
  // 소비자가 하나도 등록되지 않았으면 정책이 비어 있는 것이고, 그때는 모든 후보가 허용된다.
  const selectedConsumers = snapshot
    ? snapshot.consumers.filter((consumer) => consumer.enabled ?? !snapshot.selectionConfigured).length
    : 0;
  // 페이싱 기능 전체 스위치의 현재 값. 저장본에 칸이 없으면(이 스위치보다 오래된 정책)
  // 켜진 것으로 읽는다 — 백엔드의 기본값과 같아야 화면과 실제 동작이 어긋나지 않는다.
  const pacingOn = snapshot?.defaults.enabled ?? true;
  // 회차(이 워크플로를 돌리는 반복 요청)가 아직 없는 페이싱 워크플로. 새 회차 생성은 이들에게만
  // 연다 — 회차가 있는 워크플로에 트리거를 하나 더 달면 같은 작업이 두 소비자로 갈라져 서로
  // 예산을 경쟁하고, 백엔드도 저장을 거절한다.
  // 반복 요청이 이미 지워진 소비자 설정은 회차로 세지 않는다 — 삭제한 회차의 찌꺼기 설정이
  // 남아 있다고 새 회차를 못 만들면 그 워크플로는 영영 돌지 않는다.
  const roundlessWorkflows = workflows.filter((workflow) => workflow.pacingEnabled
    && !(snapshot?.consumers ?? []).some((consumer) => consumer.workflowId === workflow.id && consumer.scheduleExists));

  return {
    text, confirmDialog, snapshot, error, busy,
    pool, selectedConsumers, pacingOn, roundlessWorkflows,
    defaultsDraft, setDefaultsDraft, savingsDraft, setSavingsDraft, quietDraft, setQuietDraft,
    rounds, workflows,
    modal, openModal, closeModal, customProfileFor,
    panelRef, detailOpen, toggleDetail,
    load, triggerAction, setWorkflowAccounts, removeTrigger,
    toggleAccount, setAccountTarget, toggleConsumer, setConsumerPriority,
    saveDefaults, saveQuiet, togglePacing,
    quietSummary, setLaneReasoningEffort, setSpendProfile, setConsumerCeiling, toggleEnforce,
    toggleSprint, setCompletionCondition, toggleCompletionCondition, restartConsumer,
  };
}

/** 패널이 그리는 데 필요한 상태·조작 한 벌. 모달 층이 이 묶음을 통째로 받는다. */
type UsageBudgetController = ReturnType<typeof useUsageBudget>;

/**
 * 회차 하나의 설정 모달. 자매 모달 셋(예산 기본값·페이싱 스케줄·계정 풀)은 이미 각자
 * 컴포넌트인데 이 모달만 패널 본문에 140줄로 눌러앉아 있었고, 모달 안에서만 쓰이는 참여 계정
 * 파생값 넷도 패널 위쪽에 흩어져 있었다. 모달과 그 파생을 한자리로 옮겨 패널 본문에는 배치만
 * 남긴다. 저장은 전부 부모의 조작 함수가 하므로 여기에는 상태가 없다.
 */
function ConsumerSettingsModal({ consumer, snapshot, workflows, rounds, busy, customProfileOpen, onSetPriority, onSetCeiling, onToggleEnforce, onToggleConsumer, onToggleSprint, onSetCompletionCondition, onToggleCompletionCondition, onSetSpendProfile, onSetLaneEffort, onSetWorkflowAccounts, onClose, onReload }: {
  consumer: UsageBudgetConsumer;
  snapshot: UsageBudgetSnapshot;
  workflows: SystemWorkflowSummary[];
  rounds: RoundIndex;
  busy: string | null;
  /** '직접 설정'으로 레인 표를 펼쳐 둘지. 저장되는 설정이 아니라 부모가 든 열림 상태다. */
  customProfileOpen: boolean;
  onSetPriority: (consumer: UsageBudgetConsumer, raw: string) => void;
  onSetCeiling: (consumer: UsageBudgetConsumer, field: "maxTokensPerRun" | "maxCostPercentPerRun", raw: string) => void;
  onToggleEnforce: (consumer: UsageBudgetConsumer, enforceCeiling: boolean) => void;
  onToggleConsumer: (consumer: UsageBudgetConsumer, enabled: boolean) => void;
  onToggleSprint: (consumer: UsageBudgetConsumer, sprint: boolean) => void;
  onSetCompletionCondition: (consumer: UsageBudgetConsumer, raw: string) => void;
  onToggleCompletionCondition: (consumer: UsageBudgetConsumer, enabled: boolean) => void;
  onSetWorkflowAccounts: (consumer: UsageBudgetConsumer, accounts: string[]) => void;
  onClose: () => void;
  /** 트리거를 저장한 뒤 예산 화면 전체를 다시 읽는다. */
  onReload: () => void;
} & ConsumerEffortActions) {
  const { text } = useI18n();
  const accounts = workflowAccountSelection(consumer, snapshot);
  // 트리거는 한 번만 찾는다. 두 번 찾으면서 한쪽에 `!`를 붙이면 "있는지 물은 값"과
  // "없을 리 없다고 단언한 값"이 갈라져, 조건이 바뀔 때 단언 쪽만 남는다.
  const trigger = rounds.schedules.get(consumer.scheduleId) ?? null;
  // 상한이 하나도 없으면 '상한 초과 시'는 걸릴 일이 없어 잠근다. 잠긴 이유는 힌트 줄이 말한다.
  const ceilingsUnset = consumer.maxTokensPerRun === null && consumer.maxCostPercentPerRun === null;
  // 완료조건 사용 스위치. 칸이 없는 구형 백엔드에서는 문구가 있으면 곧 적용이었다. 새 회차는
  // 꺼진 채로 오므로, 아래 문구 칸은 '적어 둔 조건을 멈춘' 경우에만 잠근다 — 문구가 없는데까지
  // 잠그면 스위치를 먼저 켜지 않고는 첫 조건을 쓸 수 없고, 백엔드는 첫 문구와 함께 켜 준다.
  const completionOn = consumer.completionConditionEnabled ?? true;
  const completionTextLocked = !completionOn && !!consumer.completionCondition;

  return (
    <Modal
      title={text(`회차 설정 · ${consumer.name ?? consumer.label ?? consumer.scheduleId}`, `Round settings · ${consumer.name ?? consumer.label ?? consumer.scheduleId}`)}
      onClose={onClose}
      size="wide"
    >
      <BudgetModalSection
        title={text("페이싱 설정", "Pacing settings")}
        note={text(
          "이 구역(참여·우선순위·상한·스프린트·완료조건·소비 성향·추론수준·참여 계정)은 저장 버튼이 없습니다 — 스위치와 셀렉트는 바꾸는 즉시, 숫자·글 칸은 칸을 벗어날 때 저장됩니다. 아래 '회차 트리거'만 저장을 눌러야 반영됩니다.",
          "This section (participation, priority, ceilings, sprint, completion condition, spend profile, reasoning effort, accounts) has no save button — switches and selects save on change, number and text fields when you leave them. Only the round trigger below applies on save.",
        )}
      >
        <div className="usage-budget-defaults">
          <BudgetCommitNumberField
            label={text("우선순위 (0이 가장 높음)", "Priority (0 = highest)")}
            value={consumer.priority}
            min={0}
            max={100}
            disabled={busy !== null}
            onCommit={(raw) => onSetPriority(consumer, raw)}
          />
          <BudgetCommitNumberField
            label={text("토큰 상한/회", "Max tokens/run")}
            value={consumer.maxTokensPerRun ?? ""}
            min={0}
            step={1000}
            placeholder={text("없음", "none")}
            disabled={busy !== null}
            onCommit={(raw) => onSetCeiling(consumer, "maxTokensPerRun", raw)}
          />
          <BudgetCommitNumberField
            label={text("%p 상한/회", "Max %p/run")}
            value={consumer.maxCostPercentPerRun ?? ""}
            min={0}
            max={100}
            step={0.5}
            placeholder={text("없음", "none")}
            disabled={busy !== null}
            onCommit={(raw) => onSetCeiling(consumer, "maxCostPercentPerRun", raw)}
          />
          <BudgetToggleField
            label={text("상한 초과 시", "Over ceiling")}
            title={text("상한을 넘으면 회차를 멈추는 대신 추론수준을 한 칸 낮춥니다. 더 낮출 데가 없을 때만 쉽니다.", "Over the ceiling the round lowers its effort one rung instead of stopping. It rests only when it cannot go lower.")}
            checked={consumer.enforceCeiling}
            disabled={busy !== null || ceilingsUnset}
            switchLabel={text("상한 초과 시 추론수준 낮춤(바닥이면 쉼)", "Lower the effort when over ceiling (rest if already at the floor)")}
            onChange={(checked) => void onToggleEnforce(consumer, checked)}
          />
          <BudgetToggleField
            label={text("참여", "Enabled")}
            checked={consumer.enabled ?? !snapshot.selectionConfigured}
            disabled={busy !== null}
            switchLabel={text(`${consumer.name ?? consumer.scheduleId} 페이싱 참여`, `Include ${consumer.name ?? consumer.scheduleId} in pacing`)}
            onChange={(checked) => void onToggleConsumer(consumer, checked)}
          />
          <BudgetGridNote>
            {ceilingsUnset
              ? text("'상한 초과 시'는 위 두 상한이 모두 없어 켤 수 없습니다. 토큰이나 %p 상한을 하나라도 정하면 켜집니다.", "'Over ceiling' cannot be turned on while both ceilings above are unset. Set either the token or the %p ceiling to enable it.")
              : consumer.enforceCeiling
                ? text("'상한 초과 시'가 켜져 있어, 상한을 넘으면 추론수준을 한 칸 낮춥니다. 더 낮출 데가 없으면 쉽니다.", "'Over ceiling' is on: over the ceiling the effort drops one rung, and the round rests when it cannot go lower.")
                : text("'상한 초과 시'가 꺼져 있어, 상한을 넘어도 추론수준을 그대로 두고 진행합니다.", "'Over ceiling' is off: over the ceiling the effort stays and the round runs on.")}
          </BudgetGridNote>
          <BudgetToggleField
            label={text("스프린트", "Sprint")}
            title={text("참여 계정이 7일 창 목표와 균등 소비 직선을 무시하고, 가드 창(짧은 창)이 허락하는 만큼 몰아 돕니다. 리셋을 기다리지 않고 리셋 크레딧도 쓰지 않습니다.", "Participating accounts ignore the 7-day target and the even-consumption line and run as hard as the guard (short) window allows. They do not wait for resets and spend no reset credits.")}
            checked={consumer.sprint === true}
            disabled={busy !== null}
            switchLabel={text(`${consumer.name ?? consumer.scheduleId} 스프린트`, `Sprint ${consumer.name ?? consumer.scheduleId}`)}
            onChange={(checked) => void onToggleSprint(consumer, checked)}
          />
          <BudgetToggleField
            label={text("완료조건 사용", "Use completion condition")}
            title={text("끄면 적어 둔 문구는 그대로 두고 조건만 적용하지 않습니다 — 기동 메시지에 붙지 않고 완료 판정도 하지 않으며, 완료였던 회차는 다시 돕니다. 다시 켜면 그 완료 상태가 근거와 함께 살아납니다.", "Off keeps the text but stops applying it: it is not appended to launch messages, completion is not judged, and a completed round resumes. Turning it back on restores that completed state and its note.")}
            checked={completionOn}
            disabled={busy !== null}
            switchLabel={text(`${consumer.name ?? consumer.scheduleId} 완료조건 사용`, `Use the completion condition for ${consumer.name ?? consumer.scheduleId}`)}
            onChange={(checked) => void onToggleCompletionCondition(consumer, checked)}
          />
          <BudgetCommitTextField
            label={text("완료조건", "Completion condition")}
            title={text("자유 문구. 매 기동 메시지 끝에 이 문구와 누적 성공 건수가 붙고, 실행 에이전트가 충족을 판단하면 회차가 완료됩니다.", "Free text. It is appended to every launch message with the running success count; the agent judges when it is met and the round completes.")}
            value={consumer.completionCondition ?? ""}
            placeholder={completionTextLocked
              ? text("사용 꺼짐", "off")
              : text("예: 리팩토링 1000건 실행 · 마일스톤 완료", "e.g. 1000 refactoring runs · milestone done")}
            maxLength={400}
            disabled={busy !== null || completionTextLocked}
            onCommit={(raw) => onSetCompletionCondition(consumer, raw)}
          />
          <BudgetGridNote>
            {consumer.sprint === true
              ? text("스프린트가 켜져 있어, 참여 계정은 7일 창 목표를 무시하고 가드 창이 허락하는 만큼 몰아 돕니다. 같은 계정을 쓰는 다른 회차의 몫이 줄어듭니다. 자동 주기는 하한(10분)으로 좁혀집니다.", "Sprint is on: participating accounts ignore the 7-day target and run as hard as the guard window allows. Other rounds on the same accounts get less. Auto cadence drops to its floor (10 min).")
              : text("스프린트가 꺼져 있어, 목표를 리셋까지 균등하게 펴서 돕니다.", "Sprint is off: the target is spread evenly until reset.")}
            {" "}
            {!completionOn
              ? (consumer.completionCondition
                ? text("완료조건 사용이 꺼져 있어 적어 둔 문구는 보관만 되고 적용되지 않습니다. 회차는 스스로 끝나지 않습니다.", "The completion condition is off: the saved text is kept but not applied, so the round never ends on its own.")
                : text("완료조건이 없어 회차는 스스로 끝나지 않습니다. 문구를 적고 칸을 벗어나면 사용이 함께 켜집니다.", "Without a completion condition the round never ends on its own. Type one and leave the field — the switch turns on with it."))
              : consumer.completionCondition
                ? (consumer.completedAt != null
                  ? text(`완료조건이 충족되어 회차가 완료 상태입니다(누적 성공 ${consumer.completedRuns ?? 0}건). 카드의 '다시 시작'으로 되돌립니다. 사용을 끄면 완료가 풀려 다시 돌고, 다시 켜면 이 완료 상태로 돌아옵니다.`, `The completion condition is met and the round is completed (${consumer.completedRuns ?? 0} successful runs). Use 'Restart' on the card to resume. Turning the switch off releases the completion and the round runs again; turning it back on restores this state.`)
                  : text(`완료조건이 설정되어 매 기동 메시지 끝에 문구와 누적 성공 건수(현재 ${consumer.completedRuns ?? 0}건)가 붙습니다. 에이전트가 마지막 줄에 PACING_COMPLETE 표식을 남기면 회차가 완료되어 예약 기동이 멈춥니다.`, `A completion condition is set: every launch message ends with it and the running success count (now ${consumer.completedRuns ?? 0}). When the agent ends a reply with a PACING_COMPLETE line the round completes and scheduled launches stop.`))
                : text("완료조건이 없어 회차는 스스로 끝나지 않습니다. 문구를 적고 칸을 벗어나면 저장됩니다.", "Without a completion condition the round never ends on its own. Type one and leave the field to save.")}
          </BudgetGridNote>
        </div>
        <ConsumerEffortSection
          consumer={consumer}
          snapshot={snapshot}
          busy={busy}
          customProfileOpen={customProfileOpen}
          accounts={accounts}
          onSetSpendProfile={onSetSpendProfile}
          onSetLaneEffort={onSetLaneEffort}
        />
        {consumer.workflowId && accounts.selectable.length > 0 && (
          <ConsumerWorkflowAccounts
            accounts={accounts}
            busy={busy}
            onChange={(next) => onSetWorkflowAccounts(consumer, next)}
          />
        )}
      </BudgetModalSection>
      {trigger
        ? (
          <BudgetModalSection
            title={text("회차 트리거", "Round trigger")}
            note={text("이름·주기·워크플로 인자는 저장을 눌러야 반영됩니다.", "Name, cadence, and workflow arguments apply only when you press save.")}
          >
            <PacedTriggerEditor
              embedded
              workflows={workflows}
              schedule={trigger}
              guardWindowLabel={snapshot.defaults.guardWindowLabel ?? null}
              quietHours={snapshot.defaults.quietHours ?? null}
              onSaved={() => { onClose(); onReload(); }}
              onCancel={onClose}
            />
          </BudgetModalSection>
        )
        : (
          <p className="usage-budget-modal-note">
            {text("이 소비자의 반복 요청이 없어 트리거를 고칠 수 없습니다. 설정만 남아 있습니다.", "This consumer has no scheduled request, so there is no trigger to edit — only its settings remain.")}
          </p>
        )}
    </Modal>
  );
}

/**
 * 화면 맨 위의 페이싱 요약 머리단. 지금 상태를 한눈에 보여 주고 전체 스위치·스케줄·
 * 새로고침만 거는 단면인데, 아래 예산 카드와 한 함수 안에 붙어 있어 패널 본문을 읽으려면
 * 이 50줄을 먼저 지나야 했다. 이미 `AccountPoolSection`·`DrainStatusCard`가 나간 것과 같은
 * 모양으로, 실제로 쓰는 값만 인자로 받아 떼어낸다.
 */
function PacingOverviewSection({ snapshot, pool, selectedConsumers, pacingOn, busy, quietSummary, onTogglePacing, onOpenSchedule, onReload }: {
  snapshot: UsageBudgetSnapshot | null;
  pool: PoolSummary;
  selectedConsumers: number;
  pacingOn: boolean;
  busy: string | null;
  quietSummary: string | null;
  onTogglePacing: (enabled: boolean) => void;
  onOpenSchedule: () => void;
  onReload: () => void;
}) {
  const { text } = useI18n();
  return (
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
            onChange={onTogglePacing}
          />
        </div>
        <button className="button" type="button" onClick={onOpenSchedule} disabled={!snapshot} data-ui-anchor="workflows.usage-budget.schedule" title={text("페이싱 스케줄", "Pacing schedule")}>
          <CalendarClock size={14} /> {text("스케줄", "Schedule")}
          {quietSummary && <small>{quietSummary}</small>}
        </button>
        <button className="icon-button" type="button" onClick={onReload} disabled={busy !== null} aria-label={text("새로고침", "Refresh")} title={text("새로고침", "Refresh")}>
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
  );
}

/**
 * 페이싱 회차 목록 단면. 회차 카드·회차가 없는 워크플로 행·둘 다 없을 때의 빈 문구가
 * 한 덩어리로 움직이는데, 이 셋만 `roundlessWorkflows`를 함께 본다. 패널 본문에서 갈라
 * 놓으면 예산 카드 쪽 상태와 회차 쪽 상태가 눈으로 구분된다.
 */
function PacedRoundsSection({ snapshot, workflows, rounds, roundlessWorkflows, pacingOn, busy, detailOpen, onToggleDetail, onTriggerAction, onEditConsumer, onRemoveTrigger, onRestartConsumer, onCreateRound }: {
  snapshot: UsageBudgetSnapshot;
  workflows: SystemWorkflowSummary[];
  rounds: RoundIndex;
  roundlessWorkflows: SystemWorkflowSummary[];
  pacingOn: boolean;
  busy: string | null;
  detailOpen: (scheduleId: string) => boolean;
  onToggleDetail: (scheduleId: string) => void;
  onTriggerAction: TriggerAction;
  onEditConsumer: (scheduleId: string) => void;
  onRemoveTrigger: (trigger: ScheduledRequest) => Promise<void>;
  onRestartConsumer: (consumer: UsageBudgetConsumer) => Promise<void>;
  onCreateRound: (workflowId: string) => void;
}) {
  const { text } = useI18n();
  return (
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
        {snapshot.consumers.filter((consumer) => consumer.scheduleExists).map((consumer) => (
          <ConsumerRoundCard
            key={consumer.scheduleId}
            consumer={consumer}
            snapshot={snapshot}
            workflows={workflows}
            rounds={rounds}
            pacingOn={pacingOn}
            busy={busy}
            detailsOpen={detailOpen(consumer.scheduleId)}
            onToggleDetails={() => onToggleDetail(consumer.scheduleId)}
            onTriggerAction={onTriggerAction}
            onEdit={() => onEditConsumer(consumer.scheduleId)}
            onRemoveTrigger={onRemoveTrigger}
            onRestart={() => void onRestartConsumer(consumer)}
          />
        ))}
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
                onClick={() => onCreateRound(workflow.id)}
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
  );
}

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
export function UsageBudgetPanel({ active }: { active: boolean }) {
  const budget = useUsageBudget(active);
  const {
    text, confirmDialog, snapshot, error, busy,
    pool, selectedConsumers, pacingOn, roundlessWorkflows,
    rounds, workflows,
    openModal, panelRef, detailOpen, toggleDetail,
    load, triggerAction, removeTrigger, restartConsumer, togglePacing, quietSummary,
  } = budget;

  return (
    <>
      <PacingOverviewSection
        snapshot={snapshot}
        pool={pool}
        selectedConsumers={selectedConsumers}
        pacingOn={pacingOn}
        busy={busy}
        quietSummary={quietSummary}
        onTogglePacing={togglePacing}
        onOpenSchedule={() => openModal({ kind: "schedule" })}
        onReload={() => void load()}
      />

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
          <button className="button" type="button" onClick={() => openModal({ kind: "defaults" })} disabled={!snapshot}>
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
        {snapshot && <DrainStatusCard snapshot={snapshot} />}
        {snapshot && (
          <div className="settings-card-sections">
            <AccountPoolSection snapshot={snapshot} pool={pool} busy={busy} onOpenPool={() => openModal({ kind: "pool" })} />

            <PacedRoundsSection
              snapshot={snapshot}
              workflows={workflows}
              rounds={rounds}
              roundlessWorkflows={roundlessWorkflows}
              pacingOn={pacingOn}
              busy={busy}
              detailOpen={detailOpen}
              onToggleDetail={toggleDetail}
              onTriggerAction={triggerAction}
              onEditConsumer={(scheduleId) => openModal({ kind: "consumer", scheduleId })}
              onRemoveTrigger={removeTrigger}
              onRestartConsumer={restartConsumer}
              onCreateRound={(workflowId) => openModal({ kind: "newRound", workflowId })}
            />
          </div>
        )}
      </section>

      <UsageBudgetModals budget={budget} />
      {confirmDialog}
    </>
  );
}

/**
 * 열려 있는 모달 하나를 고르는 자리. 패널 본문 끝에 `modal?.kind === …` 다섯 겹이 줄지어
 * 있었고, 그 겹들이 쓰는 초안·저장·조작 열여덟 가지가 모두 패널의 구조분해에 올라와 있어
 * 무엇이 화면 배치에 쓰이는 값이고 무엇이 모달로 흘러가기만 하는 값인지 가릴 수 없었다.
 * 고르는 일과 배선을 여기로 옮기고, 패널은 훅 묶음을 통째로 넘기기만 한다 — 모달을 하나
 * 더하거나 고칠 때 손댈 자리가 이 함수 하나로 좁아진다.
 */
function UsageBudgetModals({ budget }: { budget: UsageBudgetController }) {
  const {
    text, snapshot, error, busy, workflows, rounds, roundlessWorkflows,
    modal, closeModal, customProfileFor,
    defaultsDraft, setDefaultsDraft, savingsDraft, setSavingsDraft, quietDraft, setQuietDraft,
    load, setWorkflowAccounts, toggleAccount, setAccountTarget, toggleConsumer, setConsumerPriority,
    saveDefaults, saveQuiet, setLaneReasoningEffort, setSpendProfile, setConsumerCeiling, toggleEnforce,
    toggleSprint, setCompletionCondition, toggleCompletionCondition,
  } = budget;
  // 모달 넷은 저장본 없이는 그릴 것이 없다. 남은 하나(회차 설정)도 스냅샷에서 대상을 찾는다.
  if (!snapshot || !modal) return null;

  switch (modal.kind) {
    case "defaults":
      return (
        <BudgetDefaultsModal
          snapshot={snapshot}
          draft={defaultsDraft}
          savings={savingsDraft}
          busy={busy}
          error={error}
          onDraftChange={setDefaultsDraft}
          onSavingsChange={setSavingsDraft}
          onSave={() => void saveDefaults()}
          onClose={closeModal}
        />
      );
    case "schedule":
      return quietDraft ? (
        <PacingScheduleModal
          snapshot={snapshot}
          draft={quietDraft}
          busy={busy}
          onChange={setQuietDraft}
          onSave={() => void saveQuiet()}
          onClose={closeModal}
        />
      ) : null;
    case "pool":
      return (
        <AccountPoolModal
          snapshot={snapshot}
          busy={busy}
          onSetTarget={setAccountTarget}
          onToggle={toggleAccount}
          onClose={closeModal}
        />
      );
    case "consumer": {
      // 반복 요청이 지워지면 소비자도 스냅샷에서 사라진다. 열린 채로 대상만 없어질 수 있다.
      const consumer = snapshot.consumers.find((candidate) => candidate.scheduleId === modal.scheduleId);
      return consumer ? (
        <ConsumerSettingsModal
          consumer={consumer}
          snapshot={snapshot}
          workflows={workflows}
          rounds={rounds}
          busy={busy}
          customProfileOpen={customProfileFor === consumer.scheduleId}
          onSetPriority={setConsumerPriority}
          onSetCeiling={setConsumerCeiling}
          onToggleEnforce={toggleEnforce}
          onToggleConsumer={toggleConsumer}
          onToggleSprint={toggleSprint}
          onSetCompletionCondition={setCompletionCondition}
          onToggleCompletionCondition={toggleCompletionCondition}
          onSetSpendProfile={setSpendProfile}
          onSetLaneEffort={setLaneReasoningEffort}
          onSetWorkflowAccounts={setWorkflowAccounts}
          onClose={closeModal}
          onReload={() => void load()}
        />
      ) : null;
    }
    case "newRound":
      return (
        <Modal title={text("새 페이싱 회차", "New paced round")} onClose={closeModal} size="wide">
          <PacedTriggerEditor
            embedded
            workflows={roundlessWorkflows}
            initialWorkflowId={modal.workflowId}
            guardWindowLabel={snapshot.defaults.guardWindowLabel ?? null}
            quietHours={snapshot.defaults.quietHours ?? null}
            onSaved={() => { closeModal(); void load(); }}
            onCancel={closeModal}
          />
        </Modal>
      );
  }
}

/** 요약 줄: 채울 창과 목표, 함께 지킬 가드, 회차 간격을 한 줄로 붙인다. */
function budgetSummary(snapshot: UsageBudgetSnapshot, text: UiText): string {
  const defaults = snapshot.defaults;
  const target = defaults.targetPercent === null || defaults.targetPercent === undefined
    ? text("목표 없음", "no target")
    : `${runtimeCatalogText(defaults.windowLabel?.trim() || snapshot.windowLabel)} ${defaults.targetPercent}%`;
  const guard = defaults.guardPercent === null || defaults.guardPercent === undefined
    ? text("가드 없음", "no guard")
    : `${defaults.guardWindowLabel?.trim() ? runtimeCatalogText(defaults.guardWindowLabel.trim()) : text("가드", "guard")} ${defaults.guardPercent}%`;
  const quiet = describeQuietHours(defaults.quietHours, text);
  return `${target} · ${guard} · ${cadenceLabel(snapshot.cadenceMinutes, text)}${quiet ? ` · ${quiet}` : ""}`;
}
