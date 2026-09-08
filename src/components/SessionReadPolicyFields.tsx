import { RotateCcw, Search } from "lucide-react";
import { useMemo, useState } from "react";
import type {
  ProjectOption,
  ProviderId,
  SessionManagementStatus,
  SessionReadDetail,
  SessionReadOrigin,
  SessionReadPolicy,
  SessionReadRedaction,
} from "../types";
import {
  describeSessionReadPolicy,
  SESSION_READ_LIMITS,
  SESSION_READ_PERIOD_CHOICES,
  sessionReadDetailLabel,
  sessionReadOriginLabel,
  sessionReadPeriodChoice,
  sessionReadPeriodFromChoice,
  sessionReadProviderLabel,
  sessionStatusLabel,
} from "../lib/sessionReadPolicy";

const PROVIDERS: ProviderId[] = ["codex", "claude", "antigravity"];

/** 상태 필터로 실제 쓸 만한 값만 고른다. 나머지는 비워 둔 전체 상태로 덮인다. */
const STATUSES: SessionManagementStatus[] = [
  "completed",
  "failed",
  "interrupted",
  "stopped",
  "running",
  "archived",
];


const DETAIL_HINTS: Record<SessionReadDetail, string> = {
  summary: "세션 요약 항목만 읽습니다.",
  workRationale: "요약과 수행 작업·검증 결과·미완료 항목까지 읽고, 요청 원문과 추론은 제외합니다.",
  limitedTranscript: "분류 제한 없이 읽되 아래 출력 예산 안에서만 읽습니다.",
};

const DETAIL_CHOICES: PolicyChoice<SessionReadDetail>[] = (
  ["summary", "workRationale", "limitedTranscript"] as const
).map((detail) => ({ value: detail, label: sessionReadDetailLabel(detail) }));

const REDACTION_CHOICES: PolicyChoice<SessionReadRedaction>[] = [
  { value: "credentials", label: "기본 · 토큰·키·쿠키 제거" },
  { value: "strict", label: "강력 · 이메일·홈 경로까지 가림" },
];

/**
 * 반복 요청 편집기와 채팅 입력창이 함께 쓰는 세션 참조 범위 편집기. 값 검증과 상한은
 * 서버가 다시 강제하고, 여기서는 같은 규칙으로 미리 보여 주는 일만 한다.
 */
export function SessionReadPolicyFields({
  policy,
  origin,
  recommendation,
  projects,
  ownScopeLabel,
  disabled,
  onChange,
  onReapplyRecommendation,
}: {
  policy: SessionReadPolicy;
  origin: SessionReadOrigin;
  recommendation: SessionReadPolicy | null;
  projects: ProjectOption[];
  /** `일정 작업 경로` 자리에 쓸 이름. 채팅에서는 `이 대화 작업 경로`가 된다. */
  ownScopeLabel: string;
  disabled?: boolean;
  onChange: (next: SessionReadPolicy) => void;
  onReapplyRecommendation?: () => void;
}) {
  const [projectQuery, setProjectQuery] = useState("");
  const patch = (next: Partial<SessionReadPolicy>) => onChange({ ...policy, ...next });
  const toggleProvider = (provider: ProviderId) =>
    patch({ providers: toggleItem(policy.providers, provider) });
  const toggleStatus = (status: SessionManagementStatus) =>
    patch({ statuses: toggleItem(policy.statuses, status) });
  const toggleProject = (path: string) =>
    patch({ projects: toggleItem(policy.projects, path) });
  const patchAbsoluteRange = (key: "from" | "to", dateString: string) => {
    const currentFrom = policy.period.kind === "absoluteRange" ? policy.period.from : 0;
    const currentTo = policy.period.kind === "absoluteRange" ? policy.period.to : 0;
    patch({
      period: {
        kind: "absoluteRange",
        from: key === "from" ? dayBoundaryMs(dateString, "start") : currentFrom,
        to: key === "to" ? dayBoundaryMs(dateString, "end") : currentTo,
      },
    });
  };
  const periodChoice = sessionReadPeriodChoice(policy.period);
  const normalizedProjectQuery = projectQuery.trim().toLocaleLowerCase();
  const visibleProjects = useMemo(() => {
    if (!normalizedProjectQuery) return projects;
    return projects.filter((project) =>
      `${project.name}\n${project.path}`.toLocaleLowerCase().includes(normalizedProjectQuery),
    );
  }, [normalizedProjectQuery, projects]);
  const selectedProjectCount = projects.filter((project) => policy.projects.includes(project.path)).length;
  const canReapply = Boolean(
    recommendation && onReapplyRecommendation && origin === "manual",
  );
  return (
    <div className="session-read-fields">
      <label className="check-filter wide">
        <input
          type="checkbox"
          checked={policy.enabled}
          disabled={disabled}
          onChange={(event) => patch({ enabled: event.target.checked })}
        />{" "}
        타 에이전트 세션 참조 사용
      </label>
      <p className="session-read-summary" aria-live="polite">
        <span className={`session-read-origin ${origin}`}>{sessionReadOriginLabel(origin)}</span>
        <strong>세션 참조: {describeSessionReadPolicy(policy)}</strong>
        {canReapply && (
          <button type="button" className="button subtle" disabled={disabled} onClick={onReapplyRecommendation}>
            <RotateCcw size={12} />
            AIA 추천값 다시 적용
          </button>
        )}
      </p>
      {!policy.enabled ? (
        <small className="session-read-hint">
          켜면 이 요청이 볼 수 있는 다른 에이전트 세션의 범위를 여기서 확정합니다. 실행 중에는 이
          범위를 넓힐 수 없고, 읽기 전용·짧은 만료·감사 기록·인증정보 제거는 해제할 수 없습니다.
        </small>
      ) : (
        <div className="session-read-grid">
          <PolicySelectField
            label="프로젝트 범위"
            value={policy.projectScope}
            options={[
              { value: "scheduleCwd", label: ownScopeLabel },
              { value: "selected", label: "선택한 등록 프로젝트" },
              { value: "allRegistered", label: "전체 등록 프로젝트" },
            ]}
            disabled={disabled}
            onChange={(projectScope) => patch({ projectScope })}
          />
          {policy.projectScope === "selected" && (
            <fieldset className="session-read-projects wide">
              <legend>등록 프로젝트 선택</legend>
              {projects.length === 0 ? (
                <small>Agent Manager가 확인한 등록 프로젝트가 없습니다.</small>
              ) : (
                <>
                  <div className="session-read-project-toolbar">
                    <strong>{selectedProjectCount}개 선택</strong>
                    <div>
                      <button
                        type="button"
                        className="button"
                        disabled={disabled || selectedProjectCount === projects.length}
                        onClick={() => patch({ projects: projects.map((project) => project.path) })}
                      >
                        모두 선택
                      </button>
                      <button
                        type="button"
                        className="button"
                        disabled={disabled || policy.projects.length === 0}
                        onClick={() => patch({ projects: [] })}
                      >
                        선택 해제
                      </button>
                    </div>
                  </div>
                  <label className="session-read-project-search">
                    <Search size={14} aria-hidden="true" />
                    <input
                      type="search"
                      value={projectQuery}
                      disabled={disabled}
                      onChange={(event) => setProjectQuery(event.target.value)}
                      placeholder="프로젝트 이름·경로 검색"
                      aria-label="등록 프로젝트 검색"
                    />
                  </label>
                  {visibleProjects.length === 0 ? (
                    <p className="session-read-project-empty">검색 결과가 없습니다.</p>
                  ) : (
                    <div className="session-read-project-list">
                      {visibleProjects.map((project) => {
                        const selected = policy.projects.includes(project.path);
                        return (
                          <label
                            className={`session-read-project-option${selected ? " selected" : ""}`}
                            key={project.path}
                            title={project.path}
                          >
                            <input
                              type="checkbox"
                              checked={selected}
                              disabled={disabled}
                              onChange={() => toggleProject(project.path)}
                            />
                            <span>
                              <strong>{project.name}</strong>
                              <small>{project.path}</small>
                            </span>
                            <em>세션 {project.count}개</em>
                          </label>
                        );
                      })}
                    </div>
                  )}
                </>
              )}
              <small>
                등록 프로젝트만 고를 수 있습니다. 목록에 없는 경로는 저장 시점과 실행 시점 모두
                거부됩니다.
              </small>
            </fieldset>
          )}
          <PolicyChipGroup
            legend="공급자"
            options={PROVIDERS}
            selected={policy.providers}
            disabled={disabled}
            labelFor={sessionReadProviderLabel}
            hint="비워 두면 전체 공급자입니다."
            onToggle={toggleProvider}
          />
          <PolicySelectField
            label="기간"
            value={periodChoice}
            options={SESSION_READ_PERIOD_CHOICES}
            disabled={disabled}
            onChange={(choice) => patch({ period: sessionReadPeriodFromChoice(choice, policy.period) })}
          />
          {policy.period.kind === "recentDays" && (
            <PolicyNumberField
              label="최근 N일"
              value={policy.period.days}
              max={SESSION_READ_LIMITS.recentDays}
              disabled={disabled}
              onChange={(days) => patch({ period: { kind: "recentDays", days } })}
            />
          )}
          {policy.period.kind === "absoluteRange" && (
            <label className="wide">
              <span>직접 범위</span>
              <div className="session-read-range">
                <input
                  type="date"
                  value={dateInputValue(policy.period.from)}
                  disabled={disabled}
                  onChange={(event) => patchAbsoluteRange("from", event.target.value)}
                />
                <b>~</b>
                <input
                  type="date"
                  value={dateInputValue(policy.period.to)}
                  disabled={disabled}
                  onChange={(event) => patchAbsoluteRange("to", event.target.value)}
                />
              </div>
            </label>
          )}
          <PolicyChipGroup
            legend="세션 상태"
            options={STATUSES}
            selected={policy.statuses}
            disabled={disabled}
            labelFor={sessionStatusLabel}
            hint="비워 두면 전체 상태입니다."
            onToggle={toggleStatus}
          />
          <PolicySelectField
            label="상세 수준"
            value={policy.detail}
            options={DETAIL_CHOICES}
            disabled={disabled}
            hint={DETAIL_HINTS[policy.detail]}
            onChange={(detail) => patch({ detail })}
          />
          <PolicyNumberField
            label="최대 세션 수"
            value={policy.maxSessions}
            max={SESSION_READ_LIMITS.maxSessions}
            disabled={disabled}
            onChange={(maxSessions) => patch({ maxSessions })}
          />
          <PolicyNumberField
            label="세션당 최대 턴"
            value={policy.maxTurnsPerSession}
            max={SESSION_READ_LIMITS.maxTurnsPerSession}
            disabled={disabled}
            onChange={(maxTurnsPerSession) => patch({ maxTurnsPerSession })}
          />
          <PolicyNumberField
            label="페이지 크기"
            value={policy.pageSize}
            max={SESSION_READ_LIMITS.pageSize}
            disabled={disabled}
            onChange={(pageSize) => patch({ pageSize })}
          />
          <PolicySelectField
            label="민감정보 제거"
            value={policy.redaction}
            options={REDACTION_CHOICES}
            disabled={disabled}
            onChange={(redaction) => patch({ redaction })}
          />
          <label className="check-filter wide">
            <input
              type="checkbox"
              checked={policy.includeLinkedFiles}
              disabled={disabled}
              onChange={(event) => patch({ includeLinkedFiles: event.target.checked })}
            />{" "}
            세션이 참조한 연결 파일도 읽기 허용
          </label>
        </div>
      )}
    </div>
  );
}

/** 배열에 항목이 있으면 제거하고 없으면 추가하는 순수 토글 헬퍼 */
function toggleItem<T>(list: readonly T[], item: T): T[] {
  return list.includes(item) ? list.filter((current) => current !== item) : [...list, item];
}

/** 정책 상한값 등 양의 정수를 받는 숫자 입력 필드 */
function PolicyNumberField({
  label,
  value,
  max,
  disabled,
  onChange,
}: {
  label: string;
  value: number;
  max: number;
  disabled?: boolean;
  onChange: (value: number) => void;
}) {
  return (
    <label>
      <span>{label}</span>
      <input
        type="number"
        min={1}
        max={max}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}

/** 고른 값 하나를 돌려주는 선택 목록의 한 항목 */
interface PolicyChoice<T extends string> {
  value: T;
  label: string;
}

/**
 * 정책 값 하나를 고르는 선택 목록. 라벨·`<select>`·안내문을 손으로 되풀이하면 필드마다
 * 형태가 조금씩 갈리므로, 값 종류만 제네릭으로 받아 한 벌로 그린다.
 */
function PolicySelectField<T extends string>({
  label,
  value,
  options,
  disabled,
  hint,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly PolicyChoice<T>[];
  disabled?: boolean;
  hint?: string;
  onChange: (value: T) => void;
}) {
  return (
    <label>
      <span>{label}</span>
      <select value={value} disabled={disabled} onChange={(event) => onChange(event.target.value as T)}>
        {options.map((option) => (
          <option value={option.value} key={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {hint && <small className="session-read-hint">{hint}</small>}
    </label>
  );
}

/** 체크박스 목록으로 구성된 필터 칩 묶음 */
function PolicyChipGroup<T extends string>({
  legend,
  options,
  selected,
  disabled,
  labelFor,
  hint,
  onToggle,
}: {
  legend: string;
  options: readonly T[];
  selected: readonly T[];
  disabled?: boolean;
  labelFor: (item: T) => string;
  hint: string;
  onToggle: (item: T) => void;
}) {
  return (
    <fieldset className="session-read-chips">
      <legend>{legend}</legend>
      {options.map((item) => (
        <label className="check-filter" key={item}>
          <input
            type="checkbox"
            checked={selected.includes(item)}
            disabled={disabled}
            onChange={() => onToggle(item)}
          />{" "}
          {labelFor(item)}
        </label>
      ))}
      <small>{hint}</small>
    </fieldset>
  );
}

/** `type=date` 입력값 변환. 날짜만 다루므로 로컬 자정 기준으로 왕복한다. */
function dateInputValue(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "";
  const date = new Date(value);
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/** 로컬 날짜 문자열(YYYY-MM-DD)을 해당 일자의 시작(00:00:00) 또는 끝(23:59:59.999) 시각(ms)으로 변환 */
function dayBoundaryMs(value: string, boundary: "start" | "end"): number {
  if (!value) return 0;
  const [year, month, day] = value.split("-").map(Number);
  const [hour, minute, second, ms] = boundary === "start" ? [0, 0, 0, 0] : [23, 59, 59, 999];
  return new Date(year, month - 1, day, hour, minute, second, ms).getTime();
}
