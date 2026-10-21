import type { ScheduleRecurrence, ScheduleRun, ScheduleRunStatus, ScheduledRequest } from "../types";
import { isWaitingRunStatus } from "./schedulerSnapshot.ts";

/**
 * 대시보드 일정 행의 상태·반복 문구. 화면 컴포넌트 안에 있으면 node 시험이 닿지 않아
 * 판정 우선순위(일시정지 → 진행·대기 → 실행 요청 → 최근 실행 → 대기)를 고정할 수 없었다.
 */
type Text = (ko: string, en: string) => string;

/** 일정 행의 상태 클래스와 표시 문구가 같은 실행 판정에서 나오도록 한 자리에서 결정한다. */
export function scheduleRunStatus(schedule: ScheduledRequest, runs: ScheduleRun[], text: Text) {
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

export function recurrenceLabel(recurrence: ScheduleRecurrence, text: Text): string {
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
